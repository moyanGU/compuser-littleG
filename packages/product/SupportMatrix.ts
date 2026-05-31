export type SupportTemplateFamily =
  | 'browser'
  | 'file'
  | 'multi_window'

export interface SupportTemplateMetadata {
  id: string
  family: SupportTemplateFamily
  capabilityName: string
  title: string
  description: string
  launchPreview: string
  likelyPauseReason: string
  supportStatus: 'verified'
  scorecardIncluded: boolean
  recommendedForUi: boolean
  prerequisites: string[]
  verificationSources: string[]
  frozenClaim: string
  launchPrompt: string
  supportedWindowClasses: string[]
  verifiedEnvironment: string[]
  claimBoundary: string
  excludedFromClaim?: string[]
}

export interface SupportEnvironmentBoundary {
  machineScope: string
  endpointScope: string
  templateScope: string
  supportedWindowClasses: string[]
  notes: string[]
}

export const VERIFIED_SUPPORT_BOUNDARY: SupportEnvironmentBoundary = {
  machineScope:
    '声明范围仅限记录 live-smoke 证据的当前机器。',
  endpointScope:
    '声明范围仅限这台机器当前的 Windows-MCP endpoint；默认预期是 http://127.0.0.1:8010/mcp，除非同一个本地 endpoint 已重新验证。',
  templateScope:
    '声明范围仅限本文件中冻结的五个 Phase 4 模板。',
  supportedWindowClasses: [
    '具备稳定可提取文本的可见浏览器窗口。',
    '当前机器上的本地 Codex 桌面窗口。',
    '标题或锚点可稳定确认的微信类聊天窗口。',
  ],
  notes: [
    '编辑器中转属于已验证工作流的一部分，但产品声明不会扩大到任意桌面应用。',
    '模板描述不能泛化到远程机器、其他 Windows-MCP endpoint，或未支持的聊天客户端。',
  ],
}

export const VERIFIED_SUPPORT_TEMPLATES: readonly SupportTemplateMetadata[] = [
  {
    id: 'browser-editor-chat-reply-template',
    family: 'browser',
    capabilityName: 'skill.browser.editor_chat_reply_template',
    title: 'Browser -> Editor -> Chat Reply',
    description:
      '在当前机器上提取浏览器文本，在已验证的本地工作流中完成中转，然后把已验证回复投递到 Codex 或微信类聊天窗口。',
    launchPreview:
      '从当前机器捕获稳定浏览器文本，在已验证的本地工作流中中转，投递到 Codex 或可确认的微信类聊天目标，然后验证已发送回复。',
    likelyPauseReason:
      '如果当前浏览器窗口、Codex 窗口或微信类聊天目标在投递前无法唯一确认，可能会暂停。',
    supportStatus: 'verified',
    scorecardIncluded: true,
    recommendedForUi: true,
    prerequisites: [
      '当前机器的浏览器窗口中能看到稳定文本。',
      '投递目标是本地 Codex 窗口，或身份稳定可确认的微信类聊天窗口。',
      '当前权限模式允许执行投递动作。',
    ],
    verificationSources: ['phase4:chains', 'phase4:template-smoke', 'phase4:live-smoke'],
    frozenClaim:
      '仅在当前机器和当前 Windows-MCP endpoint 上，作为面向本地 Codex 窗口或微信类聊天窗口的已验证“浏览器 -> 编辑器 -> 聊天回复”模板提供支持。',
    launchPrompt:
      '仅在当前机器上使用“浏览器 -> 编辑器 -> 聊天回复”模板。捕获稳定浏览器文本，在已验证的本地工作流中中转，投递到本地 Codex 窗口或可确认的微信类聊天目标，并且只有拿到已验证投递证据后才算完成。',
    supportedWindowClasses: [
      '可见浏览器窗口',
      '本地 Codex 窗口',
      '微信类聊天窗口',
    ],
    verifiedEnvironment: [
      '仅限当前机器',
      '仅限当前 Windows-MCP endpoint',
      '仅限冻结的 Phase 4 模板族',
    ],
    claimBoundary:
      '不宣称支持任意桌面聊天应用、远程机器或其他 Windows-MCP endpoint。',
  },
  {
    id: 'browser-doc-desktop-deliver-template',
    family: 'browser',
    capabilityName: 'skill.browser.doc_desktop_deliver_template',
    title: 'Browser Doc -> Desktop Deliver',
    description:
      '在当前机器上捕获浏览器文档上下文，并带验证地投递到本地 Codex 窗口。',
    launchPreview:
      '从当前机器浏览器捕获稳定的文档文本，把它路由到本地 Codex 窗口，然后验证投递结果。',
    likelyPauseReason:
      '如果当前浏览器窗口或本地 Codex 窗口无法唯一确认，可能会暂停。',
    supportStatus: 'verified',
    scorecardIncluded: true,
    recommendedForUi: true,
    prerequisites: [
      '当前机器的浏览器窗口提供稳定可提取文本。',
      '投递前可以确认本地 Codex 窗口。',
    ],
    verificationSources: ['phase4:chains', 'phase4:template-smoke', 'phase4:live-smoke'],
    frozenClaim:
      '仅在当前机器和当前 Windows-MCP endpoint 上，作为投递到本地 Codex 窗口的已验证“浏览器文档 -> 桌面投递”模板提供支持。',
    launchPrompt:
      '仅在当前机器上使用“浏览器文档 -> 桌面投递”模板。捕获稳定浏览器文档文本，把它路由到本地 Codex 窗口，并且只有拿到已验证投递证据后才算完成。',
    supportedWindowClasses: [
      '可见浏览器窗口',
      '本地 Codex 窗口',
    ],
    verifiedEnvironment: [
      '仅限当前机器',
      '仅限当前 Windows-MCP endpoint',
      '仅限冻结的 Phase 4 模板族',
    ],
    claimBoundary:
      '不宣称支持任意桌面应用或泛化的桌面投递目标。',
  },
  {
    id: 'file-browser-form-submit-template',
    family: 'file',
    capabilityName: 'skill.file.browser_form_submit_template',
    title: 'File -> Browser Form Submit',
    description:
      '读取当前机器工作区中的内容，并通过当前已验证浏览器窗口完成提交或投递流程。',
    launchPreview:
      '读取工作区内容，通过当前机器浏览器窗口完成中转，然后验证提交或投递结果。',
    likelyPauseReason:
      '如果当前浏览器窗口虽然可见但还不够可确认，无法安全投递时可能会暂停。',
    supportStatus: 'verified',
    scorecardIncluded: true,
    recommendedForUi: true,
    prerequisites: [
      '源文件位于工作区内。',
      '投递前可以确认当前机器的浏览器窗口。',
    ],
    verificationSources: ['phase4:chains', 'phase4:template-smoke', 'phase4:live-smoke'],
    frozenClaim:
      '仅在当前机器和当前 Windows-MCP endpoint 上，作为通过当前已验证浏览器窗口执行的已验证“文件 -> 浏览器提交/投递”模板提供支持。',
    launchPrompt:
      '仅在当前机器上使用“文件 -> 浏览器表单提交”模板。从工作区读取源内容，通过当前已验证浏览器窗口完成路由，并且只有拿到已验证的提交或投递证据后才算完成。',
    supportedWindowClasses: ['可见浏览器窗口'],
    verifiedEnvironment: [
      '仅限当前机器',
      '仅限当前 Windows-MCP endpoint',
      '仅限冻结的 Phase 4 模板族',
    ],
    claimBoundary:
      '不宣称支持没有稳定文本的任意浏览器页面，或通过非浏览器桌面目标进行投递。',
  },
  {
    id: 'multi-window-compare-summarize-deliver-template',
    family: 'multi_window',
    capabilityName: 'skill.multi_window.compare_summarize_deliver_template',
    title: 'Multi-window Compare -> Summarize -> Deliver',
    description:
      '观察当前机器上的多个支持窗口，比较收集到的文本，总结差异，并投递已验证结果。',
    launchPreview:
      '在当前机器上观察至少两个支持窗口，比较它们的文本，总结差异，投递到 Codex 或微信类聊天目标，然后验证结果。',
    likelyPauseReason:
      '如果少于两个支持窗口可确认，或投递前观察置信度下降，可能会暂停。',
    supportStatus: 'verified',
    scorecardIncluded: true,
    recommendedForUi: true,
    prerequisites: [
      '当前机器上至少有两个可区分的支持窗口，来自浏览器、Codex 或微信类聊天界面。',
      '观察置信度保持在已验证阈值之上。',
    ],
    verificationSources: ['phase4:chains', 'phase4:template-smoke', 'phase4:live-smoke'],
    frozenClaim:
      '仅在当前机器和当前 Windows-MCP endpoint 上，当至少有两个支持窗口可用且投递目标是 Codex 或微信类聊天窗口时，作为已验证“多窗口对比 -> 总结 -> 投递”模板提供支持。',
    launchPrompt:
      '仅在当前机器上使用“多窗口对比 -> 总结 -> 投递”模板。观察至少两个支持窗口，比较它们的文本，总结差异，投递到本地 Codex 窗口或微信类聊天目标，并且只有拿到已验证投递证据后才算完成。',
    supportedWindowClasses: [
      '可见浏览器窗口',
      '本地 Codex 窗口',
      '微信类聊天窗口',
    ],
    verifiedEnvironment: [
      '仅限当前机器',
      '仅限当前 Windows-MCP endpoint',
      '仅限冻结的 Phase 4 模板族',
    ],
    claimBoundary:
      '不宣称支持任意桌面窗口组合或未知的多实例应用。',
  },
  {
    id: 'browser-extract-transform-post-template',
    family: 'browser',
    capabilityName: 'skill.browser.extract_transform_post_template',
    title: 'Browser Extract -> Transform -> Post',
    description:
      '在当前机器上提取稳定浏览器文本，完成转换后，再把已验证结果传递到本地 Codex 窗口或微信类聊天窗口。',
    launchPreview:
      '从当前机器浏览器捕获稳定文本，完成转换后传递到本地 Codex 窗口或可确认的微信类聊天目标，然后验证发布结果。',
    likelyPauseReason:
      '如果浏览器提取不稳定，或发布前无法确认本地 Codex 窗口或微信类聊天目标，可能会暂停。',
    supportStatus: 'verified',
    scorecardIncluded: true,
    recommendedForUi: true,
    prerequisites: [
      '当前机器浏览器窗口中有稳定可提取文本。',
      '最终目标是本地 Codex 窗口或在投递期间始终可确认的微信类聊天窗口。',
    ],
    verificationSources: ['phase4:chains', 'phase4:template-smoke', 'phase4:live-smoke'],
    frozenClaim:
      '仅在当前机器和当前 Windows-MCP endpoint 上，作为投递到本地 Codex 窗口或微信类聊天窗口的已验证“浏览器提取 -> 转换 -> 传递”模板提供支持。',
    launchPrompt:
      '仅在当前机器上使用“浏览器提取 -> 转换 -> 发布”模板。捕获稳定浏览器文本，完成转换后传递到本地 Codex 窗口或可确认的微信类聊天目标，并且只有拿到已验证投递证据后才算完成。',
    supportedWindowClasses: [
      '可见浏览器窗口',
      '本地 Codex 窗口',
      '微信类聊天窗口',
    ],
    verifiedEnvironment: [
      '仅限当前机器',
      '仅限当前 Windows-MCP endpoint',
      '仅限冻结的 Phase 4 模板族',
    ],
    claimBoundary:
      '不宣称支持当前已验证浏览器 / Codex / 微信类窗口集合之外的任意发布目标。',
  },
] as const

export const SUPPORT_MATRIX_EXCLUSIONS: readonly string[] = [
  '登录、CAPTCHA 或二次验证拦截的流程。',
  '除当前机器浏览器窗口、本地 Codex 窗口、或具备稳定锚点的微信类聊天窗口之外的桌面应用。',
  '没有稳定窗口身份或文本锚点的未知桌面目标。',
  '高度依赖 OCR 或纯 CV 才能继续的路径。',
  '远程机器或独立管理的 Windows 会话。',
  '当前本地已验证 endpoint 之外的其他 Windows-MCP endpoint。',
  '当前机器上无法暴露稳定可提取文本的浏览器页面。',
  '非 Windows 桌面环境。',
]

export function listVerifiedSupportTemplates(): SupportTemplateMetadata[] {
  return [...VERIFIED_SUPPORT_TEMPLATES]
}

export function listRecommendedSupportTemplates(): SupportTemplateMetadata[] {
  return VERIFIED_SUPPORT_TEMPLATES.filter(template => template.recommendedForUi)
}

export function findSupportTemplateById(id: string): SupportTemplateMetadata | undefined {
  return VERIFIED_SUPPORT_TEMPLATES.find(template => template.id === id)
}
