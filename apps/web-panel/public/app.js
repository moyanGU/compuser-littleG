const DEFAULT_PANEL_SESSION_ID = 'local-web-panel-session';

const taskInput = document.getElementById('task-input');
const runButton = document.getElementById('run-button');
const panicButton = document.getElementById('panic-button');
const restartServiceButton = document.getElementById('restart-service-button');
const taskStatus = document.getElementById('task-status');
const sessionMeta = document.getElementById('session-meta');
const launchMeta = document.getElementById('launch-meta');
const stageLabel = document.getElementById('stage-label');
const taskDropzone = document.getElementById('task-dropzone');
const attachButton = document.getElementById('attach-button');
const attachInput = document.getElementById('attach-input');
const attachmentList = document.getElementById('attachment-list');

const homeView = document.getElementById('home-view');
const decisionView = document.getElementById('decision-view');
const executingView = document.getElementById('executing-view');
const resultView = document.getElementById('result-view');

const recommendedTemplates = document.getElementById('recommended-templates');
const windowsStatus = document.getElementById('windows-status');
const decisionTitle = document.getElementById('decision-title');
const decisionSummary = document.getElementById('decision-summary');
const decisionReason = document.getElementById('decision-reason');
const decisionExtra = document.getElementById('decision-extra');
const decisionActions = document.getElementById('decision-actions');
const executingTitle = document.getElementById('executing-title');
const executingSummary = document.getElementById('executing-summary');
const pendingTemplateLaunch = document.getElementById('pending-template-launch');
const pendingPermission = document.getElementById('pending-permission');
const resultTitle = document.getElementById('result-title');
const resultSummaryMeta = document.getElementById('result-summary-meta');
const finalOutputSummary = document.getElementById('final-output-summary');
const finalOutputDetails = document.getElementById('final-output-details');
const finalOutput = document.getElementById('final-output');

const planSummary = document.getElementById('plan-summary');
const routeCards = document.getElementById('route-cards');
const timeline = document.getElementById('timeline');
const permissions = document.getElementById('permissions');
const verification = document.getElementById('verification');
const results = document.getElementById('results');
const scorecardSummary = document.getElementById('scorecard-summary');
const governanceNotes = document.getElementById('governance-notes');
const governancePermissions = document.getElementById('governance-permissions');

let currentSessionId = DEFAULT_PANEL_SESSION_ID;
let pendingAttachments = [];

runButton.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (!task && pendingAttachments.length === 0) {
    taskStatus.textContent = '请先输入任务内容，或上传至少一个附件。';
    return;
  }

  setBusy(true, '正在判断任务是否能进入已验证路径…');
  try {
    const payload = await postJson('/session/task-decision', buildTaskPayload(task));
    currentSessionId = payload.sessionId || currentSessionId;
    clearPendingAttachments();
    render(payload.state);
    setBusy(false, '任务判定已更新。');
  } catch (error) {
    setBusy(false, error instanceof Error ? error.message : String(error));
  }
});

panicButton.addEventListener('click', async () => {
  await requestEmergencyStop();
});

restartServiceButton.addEventListener('click', async () => {
  restartServiceButton.disabled = true;
  taskStatus.textContent = '正在重启桌面服务…';
  try {
    await postJson('/system/windows-mcp/restart');
    await refresh();
    taskStatus.textContent = '桌面服务已重启。';
  } catch (error) {
    taskStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    restartServiceButton.disabled = false;
  }
});

if (attachButton && attachInput) {
  attachButton.addEventListener('click', () => {
    attachInput.click();
  });

  attachInput.addEventListener('change', async event => {
    const files = Array.from(event.target.files || []);
    await appendAttachments(files);
    attachInput.value = '';
  });
}

if (taskDropzone) {
  for (const eventName of ['dragenter', 'dragover']) {
    taskDropzone.addEventListener(eventName, event => {
      event.preventDefault();
      taskDropzone.classList.add('task-dropzone-armed');
    });
  }

  for (const eventName of ['dragleave', 'dragend', 'drop']) {
    taskDropzone.addEventListener(eventName, () => {
      taskDropzone.classList.remove('task-dropzone-armed');
    });
  }

  taskDropzone.addEventListener('drop', async event => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    await appendAttachments(files);
  });
}

renderAttachmentList();
void refresh();
setInterval(() => {
  void refresh();
}, 3000);

async function refresh() {
  try {
    const state = await fetchJson(`/session/${encodeURIComponent(currentSessionId)}/state`);
    render(state);
  } catch (error) {
    taskStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

function render(state) {
  currentSessionId = state.sessionId || currentSessionId;
  sessionMeta.textContent = `会话：${currentSessionId}`;
  launchMeta.textContent = state.launchedTemplateId
    ? `模板：${localizeTemplateId(state.launchedTemplateId)}`
    : '还没有模板执行';
  stageLabel.textContent = localizeStageLabel(state.stageLabel || state.currentStage || '空闲');
  panicButton.disabled = state.emergencyStopAvailable !== true;
  taskStatus.textContent = inferStatusMessage(state);

  renderHomeView(state);
  renderDecisionView(state);
  renderExecutingView(state);
  renderResultView(state);
  renderDebug(state.debug || state);
  switchMainView(state.view);
}

function renderHomeView(state) {
  renderRecommendedTemplates(state.recommendedTemplates || []);
  renderWindowsStatus(state.windowsMcpStatus || {});
}

function renderDecisionView(state) {
  const decision = state.decision;
  if (!decision) {
    decisionTitle.textContent = '没有待处理判定';
    decisionSummary.innerHTML = '<p class="muted">当前没有待处理判定。</p>';
    decisionReason.innerHTML = '';
    decisionExtra.innerHTML = '';
    decisionActions.innerHTML = '';
    return;
  }

  decisionTitle.textContent = decision.title || '任务判定';
  decisionSummary.innerHTML = `
    <div class="status-card tone-${escapeHtml(decisionTone(decision.kind))}">
      <strong>${escapeHtml(decision.summary || '')}</strong>
      <p>${escapeHtml(decision.actionText || '')}</p>
    </div>
  `;
  decisionReason.innerHTML = `
    <div class="info-block">
      <strong>原因说明</strong>
      <p>${escapeHtml(decision.reasonText || '')}</p>
    </div>
  `;

  const extras = [];
  if (decision.rewriteSuggestion) {
    extras.push(`
      <div class="info-block">
        <strong>建议句式</strong>
        <p>${escapeHtml(decision.rewriteSuggestion)}</p>
      </div>
    `);
  }
  if (Array.isArray(decision.environmentChecklist) && decision.environmentChecklist.length > 0) {
    extras.push(`
      <div class="info-block">
        <strong>待补条件</strong>
        <ul class="flat-list">
          ${decision.environmentChecklist.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
    `);
  }
  if (Array.isArray(decision.supportBoundarySummary) && decision.supportBoundarySummary.length > 0) {
    extras.push(`
      <div class="info-block">
        <strong>支持范围提示</strong>
        <ul class="flat-list">
          ${decision.supportBoundarySummary.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
    `);
  }
  decisionExtra.innerHTML = extras.join('');
  renderDecisionActions(decision);
}

function renderDecisionActions(decision) {
  const actions = [decision.primaryAction, ...(decision.secondaryActions || [])];
  decisionActions.innerHTML = actions
    .map(action => `
      <button
        type="button"
        class="${action.id === decision.primaryAction.id ? 'primary-action' : 'ghost-button'}"
        data-decision-action="${escapeHtml(action.id)}"
      >
        ${escapeHtml(action.label)}
      </button>
    `)
    .join('');

  for (const button of decisionActions.querySelectorAll('[data-decision-action]')) {
    button.addEventListener('click', async event => {
      const actionId = event.currentTarget.getAttribute('data-decision-action');
      if (!actionId) {
        return;
      }
      await submitDecisionAction(actionId);
    });
  }
}

function renderExecutingView(state) {
  executingTitle.textContent = state.stageLabel || '正在处理任务';
  const summaryItems = [
    state.submittedTask
      ? `<div class="info-block"><strong>任务摘要</strong><p>${escapeHtml(state.submittedTask)}</p></div>`
      : '',
    `<div class="info-block"><strong>当前阶段</strong><p>${escapeHtml(localizeStageLabel(state.stageLabel || state.currentStage || ''))}</p></div>`,
  ].filter(Boolean);
  executingSummary.innerHTML = summaryItems.join('');
  renderPendingTemplateLaunch(state.pendingTemplateLaunch);
  renderPendingPermission(state.pendingPermission);
}

function renderResultView(state) {
  const result = state.result;
  const finalText = typeof state.finalText === 'string' ? state.finalText : '';
  resultTitle.textContent = result?.title || '任务结果';
  resultSummaryMeta.innerHTML = `
    <div class="info-block">
      <strong>${escapeHtml(result?.summary || '这里还没有结果摘要。')}</strong>
      <p>${escapeHtml(result?.nextActionText || '结果详情会显示在下方。')}</p>
    </div>
  `;
  finalOutput.textContent = finalText || '这里还没有最终输出。';
  renderFinalOutputSummary(finalText);
}

function renderDebug(state) {
  renderPlanSummary(state.planSummary || []);
  renderRouteCards(state.routeCards || []);
  renderTimeline(state.timeline || []);
  renderPermissionEvents(state.permissionEvents || []);
  renderVerification(state.verification || []);
  renderResults(state.results || []);
  renderScorecardSummary(state.scorecardSummary);
  renderGovernance(state.governance);
}

function switchMainView(view) {
  const map = {
    home: homeView,
    decision: decisionView,
    executing: executingView,
    result: resultView,
  };
  const activeView = Object.hasOwn(map, view) ? view : 'home';
  for (const [name, element] of Object.entries(map)) {
    element.hidden = name !== activeView;
  }
}

function inferStatusMessage(state) {
  if (state.view === 'decision' && state.decision?.title) {
    return state.decision.title;
  }
  if (state.view === 'result' && state.result?.title) {
    return state.result.title;
  }
  if (state.view === 'executing') {
    return state.stageLabel || '任务正在执行。';
  }
  return '输入任务后，面板会先判断是否能直接进入已验证路径。';
}

function renderRecommendedTemplates(items) {
  renderList(
    recommendedTemplates,
    items,
    item => `
      <details class="template-item template-tier-${escapeHtml(item.recommendationTier || 'caution')}">
        <summary>
          <strong>${escapeHtml(localizeTextBlock(item.title || item.id))}</strong>
          <span class="template-summary">${escapeHtml(localizeReadiness(item.readiness || 'unknown'))}</span>
        </summary>
        <div class="template-item-body">
          <p>${escapeHtml(localizeTextBlock(item.description || ''))}</p>
          <p class="meta">${escapeHtml(localizeTextBlock(item.readinessReason || ''))}</p>
          <div class="pending-actions">
            <button type="button" data-launch-template="${escapeHtml(item.id)}">
              直接用这个模板
            </button>
          </div>
        </div>
      </details>
    `,
    '还没有可推荐的模板。',
  );

  for (const button of recommendedTemplates.querySelectorAll('[data-launch-template]')) {
    button.addEventListener('click', async event => {
      const templateId = event.currentTarget.getAttribute('data-launch-template');
      if (!templateId) {
        return;
      }
      await launchTemplate(templateId);
    });
  }
}

function renderWindowsStatus(status) {
  const items = [
    { title: '服务状态', detail: localizeWindowsMcpState(status.state || 'unknown') },
    { title: '状态摘要', detail: localizeTextBlock(status.summary || '还没有状态摘要。') },
  ];
  if (status.endpoint) {
    items.push({ title: 'Endpoint', detail: status.endpoint });
  }
  if (typeof status.windowCount === 'number') {
    items.push({ title: '可见窗口数', detail: String(status.windowCount) });
  }
  renderList(
    windowsStatus,
    items,
    item => `
      <div class="status-item">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.detail)}</p>
      </div>
    `,
    '还没有环境状态。',
  );
}

function renderPlanSummary(items) {
  renderList(
    planSummary,
    items,
    item => `
      <div class="summary-item tone-${escapeHtml(item.tone || 'neutral')}">
        <strong>${escapeHtml(localizeTextBlock(item.title))}</strong>
        <span>${escapeHtml(localizeTextBlock(item.value))}</span>
      </div>
    `,
    '任务开始后，这里会显示计划摘要。',
  );
}

function renderRouteCards(items) {
  renderList(
    routeCards,
    items,
    item => `
      <div class="route-item">
        <strong>${escapeHtml(localizeTextBlock(item.title))}</strong>
        <p>${escapeHtml(localizeTextBlock(item.reason))}</p>
      </div>
    `,
    '还没有内部路由记录。',
  );
}

function renderTimeline(items) {
  renderList(
    timeline,
    items,
    item => `
      <div class="timeline-item timeline-${escapeHtml(item.status || 'info')}">
        <strong>${escapeHtml(localizeTextBlock(item.title))}</strong>
        <p>${escapeHtml(localizeTextBlock(item.detail))}</p>
      </div>
    `,
    '执行开始后，这里会按时间显示进展。',
  );
}

function renderPendingTemplateLaunch(item) {
  if (!item) {
    pendingTemplateLaunch.innerHTML = '<p class="muted">当前没有待确认的模板启动。</p>';
    return;
  }

  pendingTemplateLaunch.innerHTML = `
    <div class="status-card tone-warning">
      <strong>${escapeHtml(item.title || item.templateId)}</strong>
      <p>${escapeHtml(item.summary || '')}</p>
      <p>${escapeHtml(item.whyConfirmation || '')}</p>
      <p>${escapeHtml(item.nextActionSummary || '')}</p>
      <div class="action-row">
        <button type="button" class="primary-action" data-template-decision="approve">继续启动</button>
        <button type="button" class="ghost-button" data-template-decision="deny">取消启动</button>
      </div>
    </div>
  `;

  for (const button of pendingTemplateLaunch.querySelectorAll('[data-template-decision]')) {
    button.addEventListener('click', async event => {
      const decision = event.currentTarget.getAttribute('data-template-decision');
      if (!decision) {
        return;
      }
      await submitTemplateLaunchDecision(decision);
    });
  }
}

function renderPendingPermission(item) {
  if (!item) {
    pendingPermission.innerHTML = '<p class="muted">当前没有待确认的权限。</p>';
    return;
  }

  const grantButtons = (item.availableGrantScopes || [])
    .map(scope => `
      <button type="button" data-permission-action="approve" data-grant-scope="${escapeHtml(scope)}">
        允许 ${escapeHtml(localizeGrantScope(scope))}
      </button>
    `)
    .join('');

  pendingPermission.innerHTML = `
    <div class="status-card tone-warning">
      <strong>${escapeHtml(item.toolName || '待确认操作')}</strong>
      <p>${escapeHtml(item.reason || '')}</p>
      <p>${escapeHtml(item.inputSummary || '')}</p>
      <div class="action-row">
        ${grantButtons}
        <button type="button" class="ghost-button" data-permission-action="deny">拒绝</button>
      </div>
    </div>
  `;

  for (const button of pendingPermission.querySelectorAll('[data-permission-action]')) {
    button.addEventListener('click', async event => {
      const decision = event.currentTarget.getAttribute('data-permission-action');
      const grantScope = event.currentTarget.getAttribute('data-grant-scope');
      if (!decision) {
        return;
      }
      await submitPermissionDecision(decision, grantScope);
    });
  }
}

function renderPermissionEvents(items) {
  renderList(
    permissions,
    items,
    item => `
      <div class="status-item">
        <strong>${escapeHtml(item.toolName || 'tool')}</strong>
        <p>${escapeHtml(localizePermissionDecision(item.decision || 'unknown'))}</p>
        <p>${escapeHtml(localizeTextBlock(item.reason || ''))}</p>
      </div>
    `,
    '还没有权限审批记录。',
  );
}

function renderVerification(items) {
  renderList(
    verification,
    items,
    item => `
      <div class="status-item tone-${escapeHtml(item.status || 'warning')}">
        <strong>${escapeHtml(localizeVerificationStatus(item.status || 'warning'))}</strong>
        <p>${escapeHtml(localizeTextBlock(item.summary || ''))}</p>
      </div>
    `,
    '还没有验证结果。',
  );
}

function renderResults(items) {
  renderList(
    results,
    items,
    item => `
      <div class="status-item tone-${escapeHtml(item.ok ? 'success' : 'danger')}">
        <strong>${escapeHtml(item.toolName || 'tool')}</strong>
        <p>${escapeHtml(localizeTextBlock(item.summary || ''))}</p>
      </div>
    `,
    '还没有工具结果。',
  );
}

function renderScorecardSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    scorecardSummary.innerHTML = '<p class="muted">还没有 scorecard 摘要。</p>';
    return;
  }

  const totals = summary.totals || {};
  const items = [
    { title: '总运行数', detail: String(totals.total_runs || 0) },
    { title: '通过数', detail: String(totals.pass || 0) },
  ];
  renderList(
    scorecardSummary,
    items,
    item => `
      <div class="status-item">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.detail)}</p>
      </div>
    `,
    '还没有 scorecard 摘要。',
  );
}

function renderGovernance(governance) {
  if (!governance || typeof governance !== 'object') {
    governanceNotes.innerHTML = '<p class="muted">还没有支持范围说明。</p>';
    governancePermissions.innerHTML = '<p class="muted">还没有默认权限说明。</p>';
    return;
  }

  renderList(
    governanceNotes,
    governance.ordinaryUserNotes || [],
    item => `
      <div class="status-item">
        <p>${escapeHtml(localizeTextBlock(item))}</p>
      </div>
    `,
    '还没有支持范围说明。',
  );
  renderList(
    governancePermissions,
    governance.permissionDefaults || [],
    item => `
      <div class="status-item">
        <strong>${escapeHtml(localizeResourceScope(item.scope || ''))}</strong>
        <p>${escapeHtml(buildGovernancePermissionLine(item))}</p>
      </div>
    `,
    '还没有默认权限说明。',
  );
}

function renderFinalOutputSummary(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    finalOutputSummary.innerHTML = `
      <div class="result-summary-panel result-summary-panel-empty">
        <p class="result-summary-label">摘要</p>
        <p class="result-summary-lead">这里还没有最终输出。</p>
      </div>
    `;
    finalOutputDetails.open = false;
    return;
  }

  const summary = summarizeFinalOutput(normalized);
  finalOutputSummary.innerHTML = `
    <div class="result-summary-panel">
      <p class="result-summary-label">摘要</p>
      <p class="result-summary-lead">${escapeHtml(summary.lead)}</p>
      ${
        summary.bullets.length > 0
          ? `<ul class="flat-list">${summary.bullets.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
          : ''
      }
    </div>
  `;
  finalOutputDetails.open = normalized.length < 240;
}

async function appendAttachments(files) {
  if (!files.length) {
    return;
  }

  const nextItems = await Promise.all(files.map(readAttachmentFile));
  pendingAttachments = [...pendingAttachments, ...nextItems];
  renderAttachmentList();
}

function clearPendingAttachments() {
  pendingAttachments = [];
  renderAttachmentList();
}

function renderAttachmentList() {
  if (!attachmentList) {
    return;
  }

  if (pendingAttachments.length === 0) {
    attachmentList.innerHTML = '<p class="muted">还没有上传文件。</p>';
    return;
  }

  attachmentList.innerHTML = pendingAttachments
    .map((attachment, index) => `
      <div class="attachment-item">
        <div>
          <strong>${escapeHtml(attachment.name)}</strong>
          <p class="attachment-item-meta">${escapeHtml(formatAttachmentMeta(attachment))}</p>
        </div>
        <button class="ghost-button" type="button" data-remove-attachment="${index}">移除</button>
      </div>
    `)
    .join('');

  for (const button of attachmentList.querySelectorAll('[data-remove-attachment]')) {
    button.addEventListener('click', event => {
      const index = Number(event.currentTarget.getAttribute('data-remove-attachment'));
      if (!Number.isInteger(index)) {
        return;
      }
      pendingAttachments = pendingAttachments.filter((_, currentIndex) => currentIndex !== index);
      renderAttachmentList();
    });
  }
}

async function submitDecisionAction(actionId) {
  taskStatus.textContent = '正在处理判定动作…';
  try {
    const payload = await postJson(
      `/session/${encodeURIComponent(currentSessionId)}/decision-action`,
      { actionId },
    );
    render(payload.state);
    if (actionId === 'decision-view-supported-templates') {
      focusRecommendedTemplates();
    }
  } catch (error) {
    taskStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

function focusRecommendedTemplates() {
  if (!recommendedTemplates) {
    return;
  }

  recommendedTemplates.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

async function launchTemplate(templateId) {
  taskStatus.textContent = '正在准备模板…';
  try {
    const payload = await postJson(
      `/product/templates/${encodeURIComponent(templateId)}/launch`,
      { sessionId: currentSessionId },
    );
    currentSessionId = payload.sessionId || currentSessionId;
    render(payload.state);
  } catch (error) {
    if (error instanceof HttpError && error.payload?.state) {
      currentSessionId = error.payload.sessionId || currentSessionId;
      render(error.payload.state);
    }
    taskStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function submitTemplateLaunchDecision(decision) {
  taskStatus.textContent = '正在提交模板确认…';
  try {
    const payload = await postJson(
      `/session/${encodeURIComponent(currentSessionId)}/template-launch-decision`,
      { decision },
    );
    if (payload.sessionId) {
      currentSessionId = payload.sessionId;
    }
    render(payload.state);
  } catch (error) {
    taskStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function submitPermissionDecision(decision, grantScope) {
  taskStatus.textContent = '正在提交权限确认…';
  try {
    await postJson(`/session/${encodeURIComponent(currentSessionId)}/permission-decision`, {
      decision,
      grantScope: grantScope || undefined,
    });
    await refresh();
  } catch (error) {
    taskStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function requestEmergencyStop() {
  taskStatus.textContent = '正在请求紧急中止…';
  try {
    const payload = await postJson(`/session/${encodeURIComponent(currentSessionId)}/stop`);
    render(payload.state);
  } catch (error) {
    taskStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderList(target, items, template, emptyText) {
  if (!target) {
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    target.innerHTML = `<p class="muted">${escapeHtml(emptyText)}</p>`;
    return;
  }
  target.innerHTML = items.map(template).join('');
}

function buildTaskPayload(task) {
  return {
    task,
    sessionId: currentSessionId,
    attachments: pendingAttachments.map(attachment => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      base64: attachment.base64,
    })),
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || '请求失败。');
  }
  return payload;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new HttpError(body.error || body.preflight?.summary || '请求失败。', body);
  }
  return body;
}

class HttpError extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload;
  }
}

async function readAttachmentFile(file) {
  const buffer = await file.arrayBuffer();
  return {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    base64: arrayBufferToBase64(buffer),
  };
}

function summarizeFinalOutput(text) {
  const lines = text
    .split(/\r?\n+/)
    .map(item => item.trim())
    .filter(Boolean);
  const lead = (lines[0] || text).slice(0, 96);
  const bullets = lines
    .slice(1, 5)
    .map(item => item.replace(/^[-*0-9.\s]+/, '').trim())
    .filter(Boolean)
    .map(item => item.slice(0, 88));
  return { lead, bullets };
}

function formatAttachmentMeta(attachment) {
  return `${attachment.mimeType || 'application/octet-stream'} | ${formatBytes(attachment.size)}`;
}

function formatBytes(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function setBusy(disabled, message) {
  runButton.disabled = disabled;
  runButton.textContent = disabled ? '正在判断…' : '开始判断';
  taskStatus.textContent = message;
}

function decisionTone(kind) {
  switch (kind) {
    case 'direct_execute':
      return 'success';
    case 'guided_rewrite':
      return 'warning';
    case 'environment_unready':
      return 'warning';
    case 'explicit_reject':
      return 'danger';
    default:
      return 'neutral';
  }
}

function localizeTextBlock(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function localizeStageLabel(value) {
  return localizeTextBlock(value || '空闲');
}

function localizeTemplateId(value) {
  const map = {
    'browser-editor-chat-reply-template': '浏览器 -> 编辑整理 -> 聊天回复',
    'browser-doc-desktop-deliver-template': '浏览器文档 -> 桌面投递',
    'file-browser-form-submit-template': '文件 -> 浏览器表单提交',
    'multi-window-compare-summarize-deliver-template': '多窗口对比 -> 总结 -> 投递',
    'browser-extract-transform-post-template': '浏览器提取 -> 转换 -> 发布',
  };
  return map[value] || localizeTextBlock(value || '未知模板');
}

function localizeReadiness(value) {
  const map = {
    ready: '可以直接运行',
    attention: '开始前先确认',
    blocked: '现在还不能运行',
    unknown: '状态未知',
  };
  return map[value] || localizeTextBlock(value || '未知');
}

function localizeWindowsMcpState(value) {
  const map = {
    disconnected: '还没连上桌面服务',
    starting: '桌面服务正在准备',
    ready: '桌面服务已连接',
    degraded: '桌面服务可用，但状态一般',
    failed: '桌面服务连接失败',
    unknown: '状态未知',
  };
  return map[value] || localizeTextBlock(value || '未知');
}

function localizeGrantScope(value) {
  const map = {
    once: '仅这一次',
    tool: '这个动作后续都允许',
    risk: '这个风险级别后续都允许',
  };
  return map[value] || localizeTextBlock(value || '未知');
}

function localizeVerificationStatus(value) {
  const map = {
    success: '结果核对通过',
    warning: '建议再看一眼',
    danger: '结果没有核对通过',
  };
  return map[value] || localizeTextBlock(value || '未知');
}

function localizePermissionDecision(value) {
  const map = {
    allow: '直接放行',
    ask: '等待确认',
    deny: '已拒绝',
    unknown: '状态未知',
  };
  return map[value] || localizeTextBlock(value || '未知');
}

function localizeResourceScope(value) {
  const map = {
    workspace: '工作区',
    desktop: '桌面',
    external: '工作区外系统位置',
  };
  return map[value] || localizeTextBlock(value || '未知');
}

function buildGovernancePermissionLine(item) {
  return `遇到 ${item.access || '未知访问'} 时，默认会 ${localizePermissionDecision(item.decision || 'unknown')}。`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
