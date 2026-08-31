# adapters/

此目录用于存放确实无法用 DOM/ARIA/HTTP 标准语义表达的框架适配代码。

**当前为空，这是预期状态。**

Phase 1 的全库盘点证明：所有框架特化能力（浮层挂 body、遮罩动画等待、日期面板操作等）都能用标准语义重写，无一需要依赖框架私有 class。

若将来确需新增 adapter，必须：

1. 说明为什么无法用标准语义表达；
2. core 不得 import 它；
3. adapter 只能增加证据，不能绕过任何 core invariant；
4. adapter 失效时 core 走通用路径降级，不崩；
5. 不得影响 Safety Gate。
