# Entry 配置编写

Entry 只描述浏览器认证载体和会话探测能力。通用实现不根据端点名、业务字段、认证产品或 fixture 路径推断认证状态。

## URL pattern 语义

三个字段的语义并不相同：

- `landingUrlPattern`：字面子串，使用 `url.includes(pattern)`；不是正则。
- `loginUrlPatterns`：字面子串数组，任一项被当前 URL 包含即匹配；不是正则。
- `excludeUrlPatterns`：JavaScript `RegExp` 源字符串数组，用于排除不应录制的一次性认证导航和请求。

```yaml
entry:
  # 正确：字面子串
  landingUrlPattern: "host.example.test/home"

  # 错误：^ 会被当成 URL 中的普通字符
  # landingUrlPattern: "^https://host.example.test/home"

  loginUrlPatterns:
    - "/login"

  excludeUrlPatterns:
    - "\\?token="
    - "/callback(?:\\?|$)"
```

加载 Entry 时，如果 `landingUrlPattern` 含常见正则元字符，CLI 会向 stderr 输出非阻断警告。请按字段真实语义修正；不要通过在产品代码中识别某个站点或路径来规避错误配置。

## 会话 TTL 提醒

`sessionHolding.expectedPortalTtlMs` 和 `sessionHolding.warnBeforeExpiryMs` 均为可选配置。只有两者提供且估算剩余时长达到配置阈值时才提醒；没有 `warnBeforeExpiryMs` 时不产生阈值提醒。TTL 只用于展示，实际会话有效性始终由 `sessionProbe` 判定。
