# T-80 Playwright 默认 Cutover 报告

## 结论

`DSH_LOCATOR_ENGINE` 默认值已由 `legacy` 切换为 `playwright`。未设置环境变量与显式设置 `playwright` 的行为一致；显式 `DSH_LOCATOR_ENGINE=legacy` 仍保留为 T-82 之前的回滚路径。

新的放行标准遵循 T-79：HIGH 必须保持真实语义置信，位置型 selector 必须如实保存为 LOW 并进入首次验证，不再要求 G3 强制变为 HIGH。

本节点未删除 legacy、未增加框架定位适配、未修改 LLM Heal，也未改写旧 T-75 报告。
