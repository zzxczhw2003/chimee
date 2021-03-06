import { chimeeLog } from 'chimee-helper-log';
import { off as removeEvent, on as addEvent } from 'dom-helpers/events';
import { clone, isArray, isEmpty, isError, isFunction, isPlainObject, isString } from 'lodash';
import { autobind, before, nonenumerable } from 'toxic-decorators';
import { isPromise } from 'toxic-predicate-functions';
import { camelize } from 'toxic-utils';
import defaultContainerConfig from '../config/container';
import Vessel from '../config/vessel';
import VideoConfig from '../config/video';
import { videoDomAttributes } from '../const/attribute';
import Binder from '../dispatcher/binder';
import Dom from '../dispatcher/dom';
import ChimeeKernel, { getLegalBox, IChimeeKernelConfig } from '../dispatcher/kernel';
import ChimeePlugin, { IChimeePluginConstructor } from '../dispatcher/plugin';
import { isSupportedKernelType, runRejectableQueue, transObjectAttrIntoArray } from '../helper/utils';
import Chimee from '../index';
import { IVideoKernelConstructor } from '../kernels/base';
import { ChimeePictureInPictureOnWindow } from '../plugin/picture-in-picture';
import PictureInPicture from '../plugin/picture-in-picture';
import { PluginConfig, PluginOption, SingleKernelConfig, SupportedKernelType, UserConfig, UserKernelsConfig, UserKernelsConstructorMap } from '../typings/base';
declare global {
  // tslint:disable-next-line:interface-name
  interface Window {
    __chimee_picture_in_picture: ChimeePictureInPictureOnWindow;
  }
}

const pluginConfigSet: {
  [id: string]: PluginConfig | IChimeePluginConstructor,
 } = {};

const kernelsSet: { [key in SupportedKernelType]?: IVideoKernelConstructor } = {};

function convertNameIntoId(name: string): string {
  if (!isString(name)) { throw new Error(`Plugin's name must be a string, but not "${name}" in ${typeof name}`); }
  return camelize(name);
}

function checkPluginConfig(config: PluginConfig | IChimeePluginConstructor) {
  if (isFunction(config)) {
    if (!(config.prototype instanceof ChimeePlugin)) {
      throw new TypeError(`Your are trying to install plugin ${config.name}, but it's not extends from Chimee.plugin.`);
    }
    return;
  }
  if (!isPlainObject(config) || isEmpty(config)) { throw new TypeError(`plugin's config must be an Object, but not "${config}" in ${typeof config}`); }
  const { name } = config;
  if (!isString(name) || name.length < 1) { throw new TypeError(`plugin must have a legal namea, but not "${name}" in ${typeof name}`); }
}
export interface IFriendlyDispatcher {
  getTopLevel: Dispatcher['getTopLevel'];
  sortZIndex: Dispatcher['sortZIndex'];
}
/**
 * <pre>
 * Dispatcher is the hub of plugins, user, and video kernel.
 * It take charge of plugins install, use and remove
 * It also offer a bridge to let user handle video kernel.
 * </pre>
 */
export default class Dispatcher {
  /**
   * get Plugin config based on plugin's id
   * @type {[type]}
   */
  @before(convertNameIntoId)
  public static getPluginConfig(id: string): PluginConfig | void | IChimeePluginConstructor {
    return pluginConfigSet[id];
  }

  @before(convertNameIntoId)
  public static hasInstalled(id: string): boolean {
    return !!pluginConfigSet[id];
  }

  public static hasInstalledKernel(key: SupportedKernelType) {
    return isFunction(kernelsSet[key]);
  }

  @nonenumerable
  get inPictureInPictureMode(): boolean {
    return 'pictureInPictureEnabled' in document
      // @ts-ignore: support new function in document
      ? this.dom.videoElement === (document as Document).pictureInPictureElement
      : Boolean(this.plugins.pictureInPicture && this.plugins.pictureInPicture.isShown);
  }
  /**
   * static method to install plugin
   * we will store the plugin config
   * @type {string} plugin's id
   */
  @before(checkPluginConfig)
  public static install(config: PluginConfig | IChimeePluginConstructor): string {
    const { name } = config;
    const id = camelize(name);
    if (pluginConfigSet[id]) {
      /* istanbul ignore else  */
      if (process.env.NODE_ENV !== 'production') {
        chimeeLog.warn('Dispatcher', 'You have installed ' + name + ' again. And the older one will be replaced');
      }
    }
    const pluginConfig = isFunction(config)
      ? config
      : Object.assign({}, config, { id });
    pluginConfigSet[id] = pluginConfig;
    return id;
  }

  public static installKernel(key: SupportedKernelType | { [key in SupportedKernelType]?: IVideoKernelConstructor }, value?: IVideoKernelConstructor) {
    const tasks = isPlainObject(key)
      ? Object.entries(key)
      : [[ key, value ]];
    (tasks as Array<[ SupportedKernelType, IVideoKernelConstructor ]>).forEach(([ key, value ]) => {
      if (!isFunction(value)) {
        throw new Error(`The kernel you install on ${key} must be a Function, but not ${typeof value}`);
      }
      if (isFunction(kernelsSet[key])) {
        chimeeLog.warn(`You have alrady install a kernel on ${key}, and now we will replace it`);
      }
      kernelsSet[key] = value;
    });
  }

  @before(convertNameIntoId)
  public static uninstall(id: string) {
    delete pluginConfigSet[id];
  }

  // only use for debug in internal
  public static uninstallKernel(key: SupportedKernelType) {
    delete kernelsSet[key];
  }
  public binder: Binder;
  public changeWatchable: boolean = true;
  public containerConfig: Vessel;
  public destroyed: true;
  public dom: Dom;
  public kernel: ChimeeKernel;
  // to save the kernel event handler, so that we can remove it when we destroy the kernel
  public kernelEventHandlerList: Array<(...args: any[]) => any> = [];
  /**
   * plugin's order
   * @type {Array<string>}
   * @member order
   */
  public order: string[] = [];
  /**
   * all plugins instance set
   * @type {Object}
   * @member plugins
   */
  public plugins: {
    [id: string]: ChimeePlugin,
    pictureInPicture?: PictureInPicture,
  } = {};
  public ready: Promise<void>;
  /**
   * the synchronous ready flag
   * @type {boolean}
   * @member readySync
   */
  public readySync: boolean = false;
  public videoConfig: VideoConfig;
  public videoConfigReady: boolean;
  public vm: Chimee;
  /**
   * the z-index map of the dom, it contain some important infomation
   * @type {Object}
   * @member zIndexMap
   */
  public zIndexMap: {
    inner: string[];
    outer: string[];
  } = {
    inner: [],
    outer: [],
  };
  // 测试用的临时记录
  private silentLoadTempKernel: ChimeeKernel | void;
  /**
   * @param  {UserConfig} config UserConfig for whole Chimee player
   * @param  {Chimee} vm referrence of outer class
   * @return {Dispatcher}
   */
  constructor(config: UserConfig, vm: Chimee) {
    if (!isPlainObject(config)) { throw new TypeError(`UserConfig must be an Object, but not "${config}" in ${typeof config}`); }
    /**
     * dom Manager
     * @type {Dom}
     */
    this.dom = new Dom(config, this);
    /**
     * Chimee's referrence
     * @type {[type]}
     */
    this.vm = vm;
    /**
     * tell user have Chimee installed finished
     * @type {Promises}
     */
    this.videoConfigReady = false;
    // create the videoconfig
    this.videoConfig = new VideoConfig(this, config);
    // support both plugin and plugins here as people often cofuse both
    if (isArray(config.plugins) && !isArray(config.plugin)) {
      config.plugin = config.plugins;
      delete config.plugins;
    }
    this.binder = new Binder(this);
    this.binder.listenOnMouseMoveEvent(this.dom.videoElement);
    // use the plugin user want to use
    this.initUserPlugin(config.plugin);
    // add default config for container
    const containerConfig = Object.assign({}, defaultContainerConfig, config.container || {});
    // trigger the init life hook of plugin
    this.order.forEach((key) => this.plugins[key].runInitHook(this.videoConfig));
    this.videoConfigReady = true;
    this.videoConfig.init();
    this.containerConfig = new Vessel(this, 'container', containerConfig);
    /**
     * video kernel
     * @type {Kernel}
     */
    this.kernel = this.createKernel(this.dom.videoElement, this.videoConfig);
    this.binder.applyPendingEvents('kernel');
    if (config.noDefaultContextMenu) {
      const { noDefaultContextMenu } = config;
      const target = (noDefaultContextMenu === 'container' || noDefaultContextMenu === 'wrapper')
        ? noDefaultContextMenu
        : 'video-dom';
      this.binder.on({
        fn: (evt) => evt.preventDefault(),
        id: '_vm',
        name: 'contextmenu',
        stage: 'main',
        target,
      });
    }
    // trigger auto load event
    const asyncInitedTasks: Array<Promise<ChimeePlugin>> = [];
    this.order.forEach((key) => {
      const ready = this.plugins[key].runInitedHook();
      if (isPromise(ready)) {
        asyncInitedTasks.push(ready);
      }
    });
    this.readySync = asyncInitedTasks.length === 0;
    // tell them we have inited the whold player
    this.ready = this.readySync
      ? Promise.resolve()
      : Promise.all(asyncInitedTasks)
        .then(() => {
          this.readySync = true;
          this.onReady();
        });
    if (this.readySync) { this.onReady(); }
  }

  /**
   * destroy function called when dispatcher destroyed
   */
  public destroy() {
    for (const key in this.plugins) {
      if (this.plugins.hasOwnProperty(key)) {
        this.unuse(key);
      }
    }
    this.binder.destroy();
    delete this.binder;
    this.dom.destroy();
    delete this.dom;
    this.kernel.destroy();
    delete this.kernel;
    delete this.vm;
    delete this.plugins;
    delete this.order;
    this.destroyed = true;
  }

  public exitPictureInPicture() {
    if ('pictureInPictureEnabled' in document) {
      // if current video is not in picture-in-picture mode, do nothing
      if (this.inPictureInPictureMode) {
        window.__chimee_picture_in_picture = undefined;
        // @ts-ignore: support new function in document
        return (document as Document).exitPictureInPicture();
      }
    }
    return this.plugins.pictureInPicture && this.plugins.pictureInPicture.exitPictureInPicture();
  }

  public getPluginConfig(id: string): PluginConfig | void | IChimeePluginConstructor {
    return Dispatcher.getPluginConfig(id);
  }

  @before(convertNameIntoId)
  public hasUsed(id: string) {
    const plugin = this.plugins[id];
    return isPlainObject(plugin);
  }

  public load(
    srcOrOption: string | {
      box?: string,
      isLive?: boolean,
      kernels?: UserKernelsConfig,
      preset?: UserConfig['preset'],
      src: string,
    },
    option: {
      box?: string,
      isLive?: boolean,
      kernels?: UserKernelsConfig,
      preset?: UserConfig['preset'],
    } = {}) {
    const src: string = isString(srcOrOption)
      ? srcOrOption
      : isPlainObject(srcOrOption) && isString(srcOrOption.src)
        ? srcOrOption.src
        // give a chance for user to clear the src
        : '';
    if (!isString(srcOrOption)) {
      delete srcOrOption.src;
      option = srcOrOption;
    }
    const oldBox = this.kernel.box;
    const videoConfig = this.videoConfig;
    const {
      isLive = videoConfig.isLive,
      box = getLegalBox({ src, box: videoConfig.box }),
      preset = videoConfig.preset,
      kernels = videoConfig.kernels,
    } = option;
    if (box !== 'native' || box !== oldBox || !isEmpty(option)) {
      const video = document.createElement('video');
      const config = { isLive, box, preset, src, kernels };
      const kernel = this.createKernel(video, config);
      this.switchKernel({ video, kernel, config, notifyChange: true });
    }
    const originAutoLoad = this.videoConfig.autoload;
    this.changeUnwatchable(this.videoConfig, 'autoload', false);
    this.videoConfig.src = src || this.videoConfig.src;
    this.kernel.load(this.videoConfig.src);
    this.changeUnwatchable(this.videoConfig, 'autoload', originAutoLoad);
  }

  public onReady() {
    this.binder.trigger({
      id: 'dispatcher',
      name: 'ready',
      target: 'plugin',
    });
    this.autoloadVideoSrcAtFirst();
  }

  public async requestPictureInPicture() {
    if ('pictureInPictureEnabled' in document) {
      // if video is in picture-in-picture mode, do nothing
      if (this.inPictureInPictureMode) { return Promise.resolve(window.__chimee_picture_in_picture); }
      const pipWindow = await (this.dom.videoElement as any).requestPictureInPicture();
      window.__chimee_picture_in_picture = pipWindow;
      // if (autoplay) this.play();
      return pipWindow;
    }
    if (!Dispatcher.hasInstalled(PictureInPicture.name)) {
      Dispatcher.install(PictureInPicture);
    }
    if (!this.hasUsed(PictureInPicture.name)) {
      this.use(PictureInPicture.name);
    }
    return this.plugins.pictureInPicture.requestPictureInPicture();
  }

  public silentLoad(src: string, option: {
    abort?: boolean,
    bias?: number,
    box?: string,
    duration?: number,
    immediate?: boolean,
    increment?: number,
    isLive?: boolean,
    kernels?: UserKernelsConfig,
    preset?: UserConfig['preset'],
    repeatTimes?: number,
  } = {}): Promise<void | {}> {
    const {
      duration = 3,
      bias = 0,
      repeatTimes = 0,
      increment = 0,
      isLive = this.videoConfig.isLive,
      box = this.videoConfig.box,
      kernels = this.videoConfig.kernels,
      preset = this.videoConfig.preset,
    } = option;
    // all live stream seem as immediate mode
    // it's impossible to seek on live stream
    const immediate = option.immediate || isLive;
    // form the base config for kernel
    // it should be the same as the config now
    const config = { isLive, box, src, kernels, preset };
    // build tasks accroding repeat times
    const tasks = new Array(repeatTimes + 1).fill(1).map((value, index) => {
      return () => {
        return new Promise((resolve, reject) => {
          // if abort, give up and reject
          if (option.abort) { reject({ error: true, message: 'user abort the mission' }); }
          const video = document.createElement('video');
          const idealTime = this.kernel.currentTime + duration + increment * index;
          video.muted = true;
          const that = this;
          let newVideoReady = false;
          let kernel: ChimeeKernel;
          // bind time update on old video
          // when we bump into the switch point and ready
          // we switch
          function oldVideoTimeupdate() {
            const currentTime = that.kernel.currentTime;
            if ((bias <= 0 && currentTime >= idealTime) ||
              (bias > 0 &&
                ((Math.abs(idealTime - currentTime) <= bias && newVideoReady) ||
                (currentTime - idealTime) > bias))
            ) {
              removeEvent(that.dom.videoElement, 'timeupdate', oldVideoTimeupdate);
              removeEvent(video, 'error', videoError, true);
              if (!newVideoReady) {
                removeEvent(video, 'canplay', videoCanplay, true);
                removeEvent(video, 'loadedmetadata', videoLoadedmetadata, true);
                kernel.destroy();
                return resolve();
              }
              return reject({
                error: false,
                kernel,
                video,
              });
            }
          }
          function videoCanplay() {
            newVideoReady = true;
            // you can set it immediately run by yourself
            if (immediate) {
              removeEvent(that.dom.videoElement, 'timeupdate', oldVideoTimeupdate);
              removeEvent(video, 'error', videoError, true);
              return reject({
                error: false,
                kernel,
                video,
              });
            }
          }
          function videoLoadedmetadata() {
            if (!isLive) {
              kernel.seek(immediate ? this.kernel.currentTime : idealTime);
            }
          }
          function videoError(evt: ErrorEvent) {
            removeEvent(video, 'canplay', videoCanplay, true);
            removeEvent(video, 'loadedmetadata', videoLoadedmetadata, true);
            removeEvent(that.dom.videoElement, 'timeupdate', oldVideoTimeupdate);
            kernel.off('error', videoError);
            let error;
            // TODO: need to add the kernel error declare here
            if (evt && (evt as any).errmsg) {
              const { errmsg } = (evt as any);
              chimeeLog.error('chimee\'s silentload bump into a kernel error', errmsg);
              error = new Error(errmsg);
            } else {
              error = !isEmpty(video.error)
                ? new Error(video.error.message)
                : new Error('unknow video error');
              chimeeLog.error('chimee\'s silentload', error.message);
            }
            kernel.destroy();
            that.silentLoadTempKernel = undefined;
            return index === repeatTimes
              ? reject(error)
              : resolve(error);
          }
          addEvent(video, 'canplay', videoCanplay, true);
          addEvent(video, 'loadedmetadata', videoLoadedmetadata.bind(this), true);
          addEvent(video, 'error', videoError, true);
          kernel = this.createKernel(video, config);
          this.silentLoadTempKernel = kernel;
          kernel.on('error', videoError);
          addEvent(this.dom.videoElement, 'timeupdate', oldVideoTimeupdate);
          kernel.load();
        });
      };
    });
    return runRejectableQueue(tasks)
      .then(() => {
        const message = `The silentLoad for ${src} timed out. Please set a longer duration or check your network`;
        /* istanbul ignore else  */
        if (process.env.NODE_ENV !== 'production') {
          chimeeLog.warn('chimee\'s silentLoad', message);
        }
        return Promise.reject(new Error(message));
      }).catch((result: Error | { error: string, message: string } | { kernel: ChimeeKernel, video: HTMLVideoElement }) => {
        if (isError(result)) {
          return Promise.reject(result);
        }
        let kernelError: { error: string, message: string } | void;
        let data: { kernel: ChimeeKernel, video: HTMLVideoElement };
        if ((result as any).error) {
          kernelError = (result as { error: string, message: string });
        } else {
          data = (result as { kernel: ChimeeKernel, video: HTMLVideoElement });
        }
        if (kernelError && kernelError.error) {
        /* istanbul ignore else  */
          if (process.env.NODE_ENV !== 'production') {
            chimeeLog.warn('chimee\'s silentLoad', kernelError.message);
          }
          return Promise.reject(new Error(kernelError.message));
        }
        const { video, kernel } = data;
        if (option.abort) {
          kernel.destroy();
          return Promise.reject(new Error('user abort the mission'));
        }
        const paused = this.dom.videoElement.paused;
        if (paused) {
          this.switchKernel({ video, kernel, config });
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          addEvent(video, 'play', () => {
            this.switchKernel({ video, kernel, config });
            resolve();
          }, true);
          (video as HTMLVideoElement).play();
        });
      });
  }

  public switchKernel({ video, kernel, config, notifyChange }: {
    config: {
      box: string,
      isLive: boolean,
      kernels: UserKernelsConfig,
      preset: UserConfig['preset'],
      src: string,
    },
    kernel: ChimeeKernel,
    notifyChange?: boolean,
    video: HTMLVideoElement,
  }) {
    const oldKernel = this.kernel;
    const originVideoConfig = clone(this.videoConfig);
    this.dom.migrateVideoRequiredGuardedAttributes(video);
    this.dom.removeVideo();
    this.dom.installVideo(video);
    // as we will reset the currentVideoConfig on the new video
    // it will trigger the watch function as they maybe differnet
    // because video config will return the real situation
    // so we need to stop them
    this.videoConfig.changeWatchable = false;
    this.videoConfig.autoload = false;
    this.videoConfig.src = config.src;
    videoDomAttributes.forEach((key) => {
      if (key !== 'src') { this.videoConfig[key] = originVideoConfig[key]; }
    });
    this.videoConfig.changeWatchable = true;
    this.binder.migrateKernelEvent(oldKernel, kernel);
    this.kernel = kernel;
    this.silentLoadTempKernel = undefined;
    const { isLive, box, preset, kernels } = config;
    Object.assign(this.videoConfig, { isLive, box, preset, kernels });
    oldKernel.destroy();
    // delay video event binding
    // so that people can't feel the default value change
    // unless it's caused by autoload
    if (notifyChange) {
      if (this.binder && this.binder.bindEventOnVideo) {
        this.binder.bindEventOnVideo(video);
      }
    } else {
      setTimeout(() => {
        if (this.binder && this.binder.bindEventOnVideo) {
          this.binder.bindEventOnVideo(video);
        }
      });
    }
    // if we are in picutre in picture mode
    // we need to exit thie picture in picture mode
    if (this.inPictureInPictureMode) {
      this.exitPictureInPicture();
    }
  }

  @(autobind as MethodDecorator)
  public throwError(error: Error | string) {
    this.vm.customThrowError(error);
  }

  /**
   * unuse an plugin, we will destroy the plugin instance and exlude it
   * @param  {string} name plugin's name
   */
  @before(convertNameIntoId)
  public unuse(id: string) {
    const plugin = this.plugins[id];
    if (!plugin) {
      delete this.plugins[id];
      return;
    }
    plugin.$destroy();
    const orderIndex = this.order.indexOf(id);
    if (orderIndex > -1) {
      this.order.splice(orderIndex, 1);
    }
    delete this.plugins[id];
    // @ts-ignore: delete the plugin hooks on chimee itself
    delete this.vm[id];
  }

  /**
   * use a plugin, which means we will new a plugin instance and include int this Chimee instance
   * @param  {Object|string} option you can just set a plugin name or plugin config
   * @return {Promise}
   */
  public use(option: string | PluginOption): Promise<ChimeePlugin> {
    if (isString(option)) { option = { name: option, alias: undefined }; }
    if (!isPlainObject(option) || (isPlainObject(option) && !isString(option.name))) {
      throw new TypeError('pluginConfig do not match requirement');
    }
    if (!isString(option.alias)) { option.alias = undefined; }
    const { name, alias } = option;
    option.name = alias || name;
    delete option.alias;
    const key = camelize(name);
    const id = camelize(alias || name);
    const pluginOption = option;
    const pluginConfig = Dispatcher.getPluginConfig(key);
    if (!pluginConfig) {
      throw new TypeError('You have not installed plugin ' + key);
    }
    if (isPlainObject(pluginConfig)) {
      (pluginConfig as PluginConfig).id = id;
    }
    const plugin = isFunction(pluginConfig)
      ? new (pluginConfig as IChimeePluginConstructor)({id}, this, pluginOption)
      : new ChimeePlugin((pluginConfig as PluginConfig), this, pluginOption);
    this.plugins[id] = plugin;
    Object.defineProperty(this.vm, id, {
      configurable: true,
      enumerable: false,
      value: plugin,
      writable: false,
    });
    this.order.push(id);
    this.sortZIndex();
    if (this.videoConfigReady) {
      plugin.runInitedHook();
    }
    return plugin.ready;
  }

  private autoloadVideoSrcAtFirst() {
    if (this.videoConfig.autoload) {
      if (process.env.NODE_ENV !== 'prodution' && !this.videoConfig.src) {
        chimeeLog.warn('You have not set the src, so you better set autoload to be false. Accroding to https://github.com/Chimeejs/chimee/blob/master/doc/zh-cn/chimee-api.md#src.');
        return;
      }
      this.binder.emit({
        id: 'dispatcher',
        name: 'load',
        target: 'plugin',
      }, { src: this.videoConfig.src });
    }
  }

  private changeUnwatchable(object: any, property: string, value: any) {
    this.changeWatchable = false;
    object[property] = value;
    this.changeWatchable = true;
  }

  private createKernel(video: HTMLVideoElement, config: {
    box: string;
    isLive: boolean;
    kernels: UserKernelsConfig;
    preset: {
        flv?: IVideoKernelConstructor;
        hls?: IVideoKernelConstructor;
        mp4?: IVideoKernelConstructor;
    };
    src: string;
}) {
    const { kernels, preset } = config;
    /* istanbul ignore else  */
    if (process.env.NODE_ENV !== 'production' && isEmpty(kernels) && !isEmpty(preset)) { chimeeLog.warn('preset will be deprecated in next major version, please use kernels instead.'); }
    const presetConfig: { [key: string]: SingleKernelConfig } = {};
    let newPreset: UserKernelsConstructorMap = {};
    if (isArray(kernels)) {
      // SKC means SingleKernelConfig
      newPreset = (kernels as (Array< SupportedKernelType | SingleKernelConfig >)).reduce((kernels: UserKernelsConstructorMap, keyOrSKC: SupportedKernelType | SingleKernelConfig) => {
        // if it is a string key, it means the kernel has been pre installed.
        if (isString(keyOrSKC)) {
          if (!isSupportedKernelType(keyOrSKC)) {
            throw new Error(`We have not support ${keyOrSKC} kernel type`);
          }
          const kernelFn = kernelsSet[keyOrSKC];
          if (!isFunction(kernelFn)) {
            chimeeLog.warn(`You have not installed kernel for ${keyOrSKC}.`);
            return kernels;
          }
          kernels[keyOrSKC] = kernelFn;
          return kernels;
        }
        // if it is a SingleKernelConfig, it means user may pass in some config here
        // so we need to extract the handler
        // get the name of the handler
        // and collect the config for the handler
        if (isPlainObject(keyOrSKC)) {
          const { name, handler } = keyOrSKC;
          // if the handler is a pure string, it means the kernel has been pre installed
          if (isString(handler)) {
            if (!isSupportedKernelType(handler)) {
              throw new Error(`We have not support ${handler} kernel type`);
            }
            const kernelFn = kernelsSet[handler];
            if (!isFunction(kernelFn)) {
              chimeeLog.warn(`You have not installed kernel for ${handler}.`);
              return kernels;
            }
            kernels[handler] = kernelFn;
            presetConfig[handler] = keyOrSKC;
            return kernels;
          }
          // if the handler is a function, it means that the user pass in the kernel directly
          // if the provide name, we use it as kernel name
          // if they do not provide name, we just use the function's name
          if (isFunction(handler)) {
            const kernelName = name || handler.name;
            if (!isSupportedKernelType(kernelName)) {
              throw new Error(`We have not support ${kernelName} kernel type`);
            }
            kernels[kernelName] = handler;
            presetConfig[kernelName] = keyOrSKC;
            return kernels;
          }
          chimeeLog.warn(`When you pass in an SingleKernelConfig in Array, you must clarify it's handler, we only support handler in string or function but not ${typeof handler}`);
          return kernels;
        }
        chimeeLog.warn(`If you pass in kernels as array, you must pass in kernels in string or function, but not ${typeof keyOrSKC}`);
        return kernels;
      }, {});
    } else {
      // SKC means SingleKernelConfig
      Object.keys(kernels || {}).forEach((key: SupportedKernelType) => {
        const fnOrSKC: SupportedKernelType | SingleKernelConfig | IVideoKernelConstructor = kernels[key];
        // if it's a function, means we need to do nothing
        if (isFunction(fnOrSKC)) {
          const fn = (fnOrSKC as IVideoKernelConstructor);
          newPreset[key] = fn;
          return;
        }
        if (isPlainObject(fnOrSKC)) {
          const SKC = (fnOrSKC as SingleKernelConfig);
          const { handler } = SKC;
          // if handler is an string, it means user has pre install it
          if (isString(handler)) {
            if (!isSupportedKernelType(handler)) {
              throw new Error(`We have not support ${handler} kernel type`);
            }
            const kernelFn = kernelsSet[handler];
            if (!isFunction(kernelFn)) {
              chimeeLog.warn(`You have not installed kernel for ${handler}.`);
              return;
            }
            newPreset[key] = kernelFn;
            presetConfig[key] = SKC;
            return;
          }
          if (isFunction(handler)) {
            newPreset[key] = handler;
            presetConfig[key] = SKC;
            return;
          }
          chimeeLog.warn(`When you pass in an SingleKernelConfig in Object, you must clarify it's handler, we only support handler in string or function but not ${typeof handler}`);
          return;
        }
        chimeeLog.warn(`If you pass in kernels as object, you must pass in kernels in string or function, but not ${typeof fnOrSKC}`);
        return kernels;
      });
    }
    config.preset = Object.assign(newPreset, preset);
    const legalConfig: IChimeeKernelConfig = Object.assign(config, { presetConfig });
    const kernel = new ChimeeKernel(video, legalConfig);
    return kernel;
  }

  /**
   * get the top element's level
   * @param {boolean} inner get the inner array or the outer array
   */
  private getTopLevel(inner: boolean): number {
    const arr = this.zIndexMap[inner ? 'inner' : 'outer'];
    const plugin = this.plugins[arr[arr.length - 1]];
    return isEmpty(plugin) ? 0 : plugin.$level;
  }

  /**
   * use a set of plugin
   * @param  {Array<UserPluginConfig>}  configs  a set of plugin config
   * @return {Array<Promise>}   a set of Promise indicate the plugin install stage
   */
  private initUserPlugin(configs: Array<string | PluginOption> = []): Array<Promise<ChimeePlugin>> {
    if (!isArray(configs)) {
      /* istanbul ignore else  */
      if (process.env.NODE_ENV !== 'production') { chimeeLog.warn('Dispatcher', `UserConfig.plugin can only by an Array, but not "${configs}" in ${typeof configs}`); }
      configs = [];
    }
    return configs.map((config) => this.use(config));
  }

  /**
   * sort zIndex of plugins to make plugin display in order
   */
  private sortZIndex() {
    const { inner, outer } = this.order.reduce((levelSet, key) => {
      const plugin = this.plugins[key];
      if (isEmpty(plugin)) { return levelSet; }
      const set = levelSet[plugin.$inner ? 'inner' : 'outer'];
      const level = plugin.$level;
      set[level] = set[level] || [];
      set[level].push(key);
      return levelSet;
    }, ({ inner: {}, outer: {} }) as { inner: { [x: number]: string[] }, outer: { [x: number]: string[] }});
    inner[0] = inner[0] || [];
    inner[0].unshift('videoElement');
    outer[0] = outer[0] || [];
    outer[0].unshift('container');
    const innerOrderArr = transObjectAttrIntoArray(inner);
    const outerOrderArr = transObjectAttrIntoArray(outer);
    this.dom.setPluginsZIndex(innerOrderArr);
    this.dom.setPluginsZIndex(outerOrderArr);
    this.zIndexMap.inner = innerOrderArr;
    this.zIndexMap.outer = outerOrderArr;
  }
}
