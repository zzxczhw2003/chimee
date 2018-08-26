# control

## 介绍

1. 定义了组件基础类

1. 定义了官方组件

1. 定义了扩展自定义组件的方式

## 第一阶段优化

<!--1. 事件委托。 plugin（考虑， 研究-->

<!--1. 用户自定义组件扩展-->

<!--1. 全局 flex 或者 100% 或者 table 或者拿到数值，纯粹计算结果(重点考虑，不同屏幕下，或者不固定长度情况下，导致的一些布局问题)-->
<!--* 每个元素都会设置自己的宽度（包括官方给的自定义宽度）-->
<!--* 最后设置 progressbar 的宽度(加载出来， 但是可以不用， 只是占用固定宽度)-->

<!--1. 配置项扩展-->

<!--1. 缓存进度条-->

<!--1. 时间处理 hh:mm:ss tip 宽度 progressTime 宽度 -->

<!--1. resize 方法 table 布局后这个不在重复-->

<!--1. 拖动截流， 或者不直接设置 currentTime, 避免重复调起 seek-->

<!--1. 动画 (volume(描边动画)  play（path 变形动画)-->

<!--1. vision > chimee-->

<!-- 1. controls.false 设置时， 截断 -->

<!-- 1. 进度条出现跳动情况， 声音出现跳动情况 -->

1. 尽量不要使用默认 css 值来做什么事情， 尽量计算， 防止用户复写 css 后产生的 js 还是拿自己默认的 css 去写， 因为不同的机器／浏览器， 获取到 css 值不同

1. 有些数据流还是双向的。 可以尽量做到单向，

## 注意

1. 采用 table 布局， 根据内容撑开 cell， 可以设置 cell 中， 子元素的宽度来决定父元素的宽度

1. 鉴于 html 假如用户自定义的话， 则之前写好的组件也就没什么意义了。还不如用户重新写一个方便， 所以把 html 从已有组件用户配置项中移除 (提示用户， html 属性只有在用户完全自定义时有效， 图标组件， 提供 icon 属性， 可以替换默认 html， 较为复杂逻辑建议自定义组件)

1. css 长度，有的需要用户写一份 css 样式表来覆盖， 有的是 js 运算出来的。

## 待完善组件列表

1. 刷新

1. 清晰度