import type { ProductGovernanceView } from '../../apps/web-panel/panelTypes.js'
import {
  SUPPORT_MATRIX_EXCLUSIONS,
  VERIFIED_SUPPORT_BOUNDARY,
} from './SupportMatrix.js'
import { PRODUCT_SCORECARD_RELATIVE_PATH } from '../../apps/web-panel/defaults.js'

export const PRODUCT_GOVERNANCE_VIEW: ProductGovernanceView = {
  supportMatrixPath: '/product/support-matrix',
  scorecardArtifactPath:
    process.env.COMPUSER_PRODUCT_SCORECARD_DISPLAY_PATH?.trim() ||
    PRODUCT_SCORECARD_RELATIVE_PATH,
  permissionDefaults: [
    {
      scope: 'workspace',
      access: 'read/write',
      decision: 'allow',
      note: '工作区路径默认允许访问。',
    },
    {
      scope: 'desktop',
      access: 'read/write',
      decision: 'ask',
      note: '桌面路径访问需要用户确认。',
    },
    {
      scope: 'external',
      access: 'read/write/delete',
      decision: 'deny',
      note: '非工作区系统路径默认拒绝。',
    },
  ],
  exclusions: [...SUPPORT_MATRIX_EXCLUSIONS],
  ordinaryUserNotes: [
    '推荐卡片只会从已经验证过的模板里挑。',
    '只有拿到落地核对证据，才算真正完成，不是工具自己说成功就算。',
    '当前已发布成绩说明：在固定支持范围内，这套产品已经达到 95%+ 声明门槛。',
    '当前 endpoint 声明以已发布成绩摘要 artifact 里记录的 endpoint 为准；刷新声明前要先更新对应 scorecard artifact。',
    '普通用户入口只覆盖这台机器、当前桌面服务、固定发布的五个模板，以及浏览器 / Codex / 微信类聊天窗口。',
    '目标不明确或不在支持范围里的任务，不会进入普通用户入口。',
  ],
  supportBoundary: VERIFIED_SUPPORT_BOUNDARY,
}
