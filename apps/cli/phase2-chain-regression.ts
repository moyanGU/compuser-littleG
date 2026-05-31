import { createBuiltinCapabilities } from '../../packages/capabilities/BuiltinCapabilities.js'
import { InMemoryCapabilityCatalog } from '../../packages/capabilities/CapabilityCatalog.js'
import { createCapabilityTools } from '../../packages/capabilities/CapabilityTools.js'
import {
  InMemoryToolRegistry,
  type ToolDefinition,
} from '../../packages/tools/Tool.js'
import {
  AllowAllPermissionChecker,
  ToolRuntime,
} from '../../packages/tools/runtime/ToolRuntime.js'
import { CLI_WORKSPACE_ROOT } from './workspaceRoot.js'

async function main(): Promise<void> {
  await verifyBrowserExtractThenTransfer()
  await verifyBrowserExtractThenTransferFailsWithoutExtractableText()
  await verifyFileReadTransformTransfer()
  await verifyBrowserToEditorCaptureVerify()
  await verifyBrowserRouteCaptureTransfer()
  await verifyBrowserEditorStageAndDeliver()
  await verifyBrowserEditorChatStageAndDeliver()
  await verifyBrowserEditorChatStageAndDeliverVerify()
  await verifyBrowserEditorChatStageAndDeliverVerifyFailsWhenBaseChainFails()
  await verifyFileBrowserRouteDeliver()
  await verifyFileBrowserRouteDeliverVerify()
  await verifyFileBrowserRouteDeliverVerifyFailsWhenBaseChainFails()
  await verifyFileBrowserChatRouteDeliver()
  await verifyFileBrowserChatRouteDeliverVerify()
  await verifyFileBrowserChatRouteDeliverVerifyFailsWhenBaseChainFails()
  await verifyCrossAppOpenObserveActVerifyRecoversFromFocusDrift()
  await verifyOpenOrFocusShellRecovery()
  await verifyAppSwitchCollectCompare()
  await verifyMultiWindowObserveRouteExecute()
  await verifyMultiWindowObserveRouteExecuteRecoversFromFocusDrift()
  await verifyMultiWindowObserveRouteDeliverVerify()
  console.log('Phase 2 chain regression passed: 21/21')
}

async function verifyBrowserExtractThenTransfer(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.snapshot', [], async input => ({
      ok: true,
      summary: 'browser dom snapshot ok',
      data: {
        summary: 'browser dom snapshot ok',
        windows: ['Browser'],
        focusedWindow: 'Browser',
        observationMode: input.useDom === true ? 'dom' : 'snapshot',
        confidence: 0.92,
        anchors: ['Example selected text', 'Browser'],
        domSummary: 'title=Example; nodes=4',
        raw: {
          dom: {
            selectedText: 'Example selected text',
            title: 'Example page',
            nodes: 4,
          },
        },
      },
    })),
    createStubTool('command.app.open_or_focus', ['appName'], async input => ({
      ok: true,
      summary: `focused ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('command.clipboard.read_write', ['mode'], async input => ({
      ok: true,
      summary: `clipboard ${String(input.mode)} ok`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          mode: input.mode,
          text: input.text,
        },
      },
    })),
    createStubTool('windows.shortcut', ['shortcut'], async input => ({
      ok: true,
      summary: `shortcut ${String(input.shortcut)} ok`,
    })),
    createStubTool('windows.wait', ['durationSeconds'], async () => ({
      ok: true,
      summary: 'wait ok',
    })),
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: true,
      summary: 'desktop verify ok',
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: 'Notepad',
          lastVerifiedAnchor: 'window:Notepad',
          chainStatus: 'completed',
        },
        verificationEvidence: ['window:Notepad visible'],
        output: {
          observation: {
            summary: 'desktop verify ok',
            windows: ['Notepad'],
            focusedWindow: 'Notepad',
            observationMode: 'snapshot',
            confidence: 0.91,
            anchors: ['window:Notepad'],
          },
        },
      },
    })),
    createStubTool('windows.type', ['text'], async input => ({
      ok: true,
      summary: `typed ${String(input.text)}`,
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.extract_then_transfer',
      input: {
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser extract then transfer should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'browser extract then transfer should include successful verification',
  )
  const output = readOutput(result.data) as {
    extractedText?: string
    transferred?: boolean
  }
  assert(
    output.extractedText === 'Example selected text',
    'browser extract then transfer should preserve extracted text',
  )
  assert(output.transferred === true, 'browser extract then transfer should mark transfer success')
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.currentArtifact === 'browser-dom-extract' &&
      chainState.chainStatus === 'completed',
    'browser extract then transfer should persist completed chain state',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('extracted=Example selected text')),
    'browser extract then transfer should surface extraction evidence',
  )
}

async function verifyBrowserExtractThenTransferFailsWithoutExtractableText(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.snapshot', [], async input => ({
      ok: true,
      summary: 'weak dom snapshot',
      data: {
        summary: 'weak dom snapshot',
        windows: ['Browser'],
        focusedWindow: 'Browser',
        observationMode: input.useDom === true ? 'dom' : 'snapshot',
        confidence: 0.88,
        anchors: ['Browser'],
        raw: {
          dom: {
            nodes: 3,
          },
        },
      },
    })),
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: true,
      summary: 'desktop observe ok',
      data: {
        verification: {
          passed: true,
        },
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.extract_then_transfer',
      input: {
        targetWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(!result.ok, 'browser extract then transfer should fail without extractable text')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === false,
    'browser extract then transfer failure should fail verification',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentArtifact === 'browser-dom-extract' &&
    chainState?.chainStatus === 'verified_failed',
    'missing extractable text should map to verified_failed',
  )
}

async function verifyFileReadTransformTransfer(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('command.workspace.read_text', ['path'], async input => ({
      ok: true,
      summary: `read ${String(input.path)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          path: String(input.path),
          startLine: 1,
          endLine: 2,
          lines: ['hello', 'world'],
        },
      },
    })),
    createStubTool('command.app.open_or_focus', ['appName'], async input => ({
      ok: true,
      summary: `focused ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('command.desktop.capture_and_locate', ['query'], async input => ({
      ok: true,
      summary: `captured ${String(input.query)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('skill.cross_app.transfer_text', ['text', 'targetWindowTitle'], async input => ({
      ok: true,
      summary: `transferred ${String(input.targetWindowTitle)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: true,
      summary: 'desktop verify ok',
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: 'Notepad',
          lastVerifiedAnchor: 'window:Notepad',
          chainStatus: 'completed',
        },
        verificationEvidence: ['window:Notepad visible'],
        output: {
          observation: {
            summary: 'desktop verify ok',
            windows: ['Notepad'],
            focusedWindow: 'Notepad',
            observationMode: 'snapshot',
            confidence: 0.91,
            anchors: ['window:Notepad'],
          },
        },
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file_read_transform_transfer',
      input: {
        path: 'demo.txt',
        targetWindowTitle: 'Notepad',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'file read transform transfer should succeed')
  const output = readOutput(result.data) as {
    transformedText?: string
  }
  assert(
    output.transformedText === 'HELLO\nWORLD',
    'file read transform transfer should apply the requested transform',
  )
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'file read transform transfer should include successful verification',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.cross_app.open_observe_act_verify'),
    'file read transform transfer should use the downstream editor verification chain',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('window:Notepad visible')),
    'file read transform transfer should preserve downstream verification evidence',
  )
}

async function verifyBrowserToEditorCaptureVerify(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.snapshot', [], async input => ({
      ok: true,
      summary: 'browser dom snapshot ok',
      data: {
        summary: 'browser dom snapshot ok',
        windows: ['Browser'],
        focusedWindow: 'Browser',
        observationMode: input.useDom === true ? 'dom' : 'snapshot',
        confidence: 0.9,
        anchors: ['Captured page text', 'Browser'],
        domSummary: 'title=Captured page',
        raw: {
          dom: {
            selectedText: 'Captured page text',
            title: 'Captured page',
            nodes: 8,
          },
        },
      },
    })),
    createStubTool('command.app.open_or_focus', ['appName'], async input => ({
      ok: true,
      summary: `focused ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('command.clipboard.read_write', ['mode'], async input => ({
      ok: true,
      summary: `clipboard ${String(input.mode)} ok`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          mode: input.mode,
          text: input.text,
        },
      },
    })),
    createStubTool('windows.shortcut', ['shortcut'], async input => ({
      ok: true,
      summary: `shortcut ${String(input.shortcut)} ok`,
    })),
    createStubTool('windows.type', ['text'], async input => ({
      ok: true,
      summary: `typed ${String(input.text)}`,
    })),
    createStubTool('skill.desktop.observe', [], async () => ({
      ok: true,
      summary: 'desktop verify ok',
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: 'Notepad',
          lastVerifiedAnchor: 'window:Notepad',
          chainStatus: 'completed',
        },
        verificationEvidence: ['window:Notepad visible'],
        output: {
          observation: {
            summary: 'desktop verify ok',
            windows: ['Notepad'],
            focusedWindow: 'Notepad',
            observationMode: 'snapshot',
            confidence: 0.91,
            anchors: ['window:Notepad'],
          },
        },
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser_to_editor.capture_verify',
      input: {
        appName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser to editor capture verify should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'browser to editor capture verify should verify success',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('command.browser.inspect_dom') &&
      operations.includes('skill.cross_app.open_observe_act_verify'),
    'browser to editor capture verify should expose the browser capture and downstream chain operations',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('window:Notepad visible')),
    'browser to editor capture verify should preserve downstream verification evidence',
  )
}

async function verifyBrowserRouteCaptureTransfer(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.snapshot', [], async input => ({
      ok: true,
      summary: 'browser dom snapshot ok',
      data: {
        summary: 'browser dom snapshot ok',
        windows: ['Browser'],
        focusedWindow: 'Browser',
        observationMode: input.useDom === true ? 'dom' : 'snapshot',
        confidence: 0.92,
        anchors: ['Need reply in WeChat', 'Browser'],
        domSummary: 'title=Captured page',
        raw: {
          dom: {
            selectedText: 'Need reply in WeChat',
            title: 'Captured page',
            nodes: 6,
          },
        },
      },
    })),
    createStubTool(
      'skill.app.switch_collect_compare',
      ['primaryWindowTitle', 'secondaryWindowTitle'],
      async input => ({
        ok: true,
        summary: `compared ${String(input.primaryWindowTitle)} and ${String(input.secondaryWindowTitle)}`,
        data: {
          verification: {
            passed: true,
          },
          output: {
            primaryEvidence: ['content:codex task queue', 'anchor:Codex'],
            secondaryEvidence: ['content:wechat reply draft', 'anchor:WeChat'],
            comparisonSummary: 'comparison=wechat reply draft vs codex task queue',
            identical: false,
          },
          verificationEvidence: ['comparison=wechat reply draft vs codex task queue'],
        },
      }),
    ),
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async input => ({
      ok: true,
      summary: `executed ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: String(input.appName),
          lastVerifiedAnchor: `verified:${String(input.appName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`verified:${String(input.appName)}`],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.route_capture_transfer',
      input: {
        primaryWindowTitle: 'Codex',
        secondaryWindowTitle: 'WeChat',
        routeQuery: 'wechat',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser route capture transfer should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'browser route capture transfer should verify success',
  )
  const output = readOutput(result.data) as {
    extractedText?: string
    selectedWindowTitle?: string
    routeReason?: string
    verified?: boolean
  }
  assert(
    output.extractedText === 'Need reply in WeChat',
    'browser route capture transfer should preserve extracted browser text',
  )
  assert(
    output.selectedWindowTitle === 'WeChat',
    'browser route capture transfer should route to the better matching target',
  )
  assert(
    output.verified === true &&
      typeof output.routeReason === 'string' &&
      output.routeReason.includes('wechat'),
    'browser route capture transfer should expose verified route reasoning',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('command.browser.inspect_dom') &&
      operations.includes('skill.app.switch_collect_compare') &&
      operations.includes('skill.cross_app.open_observe_act_verify'),
    'browser route capture transfer should compose browser capture, compare, and verified execute stages',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('extracted=Need reply in WeChat')) &&
      evidence.some(item => item.includes('routeReason=')) &&
      evidence.some(item => item.includes('verified:WeChat')),
    'browser route capture transfer should preserve extraction, routing, and verification evidence',
  )
}

async function verifyBrowserEditorStageAndDeliver(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.browser_to_editor.capture_verify', ['appName'], async input => ({
      ok: true,
      summary: `staged ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          extractedText: 'Need reply in WeChat',
          targetWindowTitle: String(input.appName),
          transferred: true,
        },
        chainState: {
          currentTarget: String(input.appName),
          currentArtifact: 'browser-dom-extract',
          lastVerifiedAnchor: `staged:${String(input.appName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`staged:${String(input.appName)}`, 'extracted=Need reply in WeChat'],
      },
    })),
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async input => ({
      ok: true,
      summary: `delivered ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: String(input.appName),
          currentArtifact: 'open-observe-act-verify',
          lastVerifiedAnchor: `verified:${String(input.appName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`verified:${String(input.appName)}`],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_stage_and_deliver',
      input: {
        editorAppName: 'Notepad',
        finalAppName: 'WeChat',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser editor stage and deliver should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'browser editor stage and deliver should verify success',
  )
  const output = readOutput(result.data) as {
    extractedText?: string
    selectedWindowTitle?: string
    currentStage?: string
    currentArtifact?: string
    delivered?: boolean
  }
  assert(
    output.extractedText === 'Need reply in WeChat',
    'browser editor stage and deliver should preserve staged text',
  )
  assert(
    output.selectedWindowTitle === 'WeChat',
    'browser editor stage and deliver should expose final selected target',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'browser-editor-final-delivery' &&
      output.delivered === true,
    'browser editor stage and deliver should expose final template stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.browser_to_editor.capture_verify') &&
      operations.includes('skill.cross_app.open_observe_act_verify'),
    'browser editor stage and deliver should compose verified staging and final delivery chains',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('stageTarget=Notepad')) &&
      evidence.some(item => item.includes('finalTarget=WeChat')) &&
      evidence.some(item => item.includes('verified:WeChat')),
    'browser editor stage and deliver should preserve staging and final verification evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'WeChat' &&
      chainState.currentArtifact === 'browser-editor-final-delivery' &&
      chainState.chainStatus === 'completed',
    'browser editor stage and deliver should persist completed final target chain state',
  )
}

async function verifyBrowserEditorChatStageAndDeliver(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.browser.editor_stage_and_deliver', ['editorAppName', 'finalAppName'], async input => ({
      ok: true,
      summary: `staged ${String(input.editorAppName)} to ${String(input.finalAppName)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          extractedText: 'Need reply in chat',
          editorTargetWindowTitle: String(input.editorAppName),
          finalTargetWindowTitle: String(input.finalAppName),
          staged: true,
          delivered: true,
        },
        chainState: {
          currentTarget: String(input.finalAppName),
          currentArtifact: 'browser-editor-final-delivery',
          lastVerifiedAnchor: `verified:${String(input.finalAppName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`verified:${String(input.finalAppName)}`],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_chat_stage_and_deliver',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser editor chat stage and deliver should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'browser editor chat stage and deliver should verify success',
  )
  const output = readOutput(result.data) as {
    extractedText?: string
    selectedWindowTitle?: string
    currentStage?: string
    currentArtifact?: string
    delivered?: boolean
  }
  assert(
    output.extractedText === 'Need reply in chat',
    'browser editor chat stage and deliver should preserve staged text',
  )
  assert(
    output.selectedWindowTitle === 'Codex',
    'browser editor chat stage and deliver should expose the chat target',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'browser-editor-chat-delivery' &&
      output.delivered === true,
    'browser editor chat stage and deliver should expose final template stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.browser.editor_stage_and_deliver'),
    'browser editor chat stage and deliver should compose the staging chain',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('chatTarget=Codex')),
    'browser editor chat stage and deliver should preserve chat target evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Codex' &&
      chainState.chainStatus === 'completed',
    'browser editor chat stage and deliver should persist completed chat target chain state',
  )
}

async function verifyBrowserEditorChatStageAndDeliverVerify(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.browser.editor_chat_stage_and_deliver', ['editorAppName', 'chatAppName'], async input => ({
      ok: true,
      summary: `staged ${String(input.editorAppName)} to ${String(input.chatAppName)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          extractedText: 'Need reply in chat',
          editorTargetWindowTitle: String(input.editorAppName),
          chatTargetWindowTitle: String(input.chatAppName),
          staged: true,
          delivered: true,
          currentStage: 'delivered',
          currentArtifact: 'browser-editor-chat-delivery',
        },
        chainState: {
          currentTarget: String(input.chatAppName),
          currentArtifact: 'browser-editor-chat-delivery',
          lastVerifiedAnchor: `verified:${String(input.chatAppName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`verified:${String(input.chatAppName)}`],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_chat_stage_and_deliver_verify',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'browser editor chat stage and deliver verify should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'browser editor chat stage and deliver verify should verify success',
  )
  const output = readOutput(result.data) as {
    extractedText?: string
    selectedWindowTitle?: string
    chatTargetWindowTitle?: string
    currentStage?: string
    currentArtifact?: string
    delivered?: boolean
    verified?: boolean
  }
  assert(
    output.extractedText === 'Need reply in chat',
    'browser editor chat stage and deliver verify should preserve staged text',
  )
  assert(
    (output.selectedWindowTitle ?? output.chatTargetWindowTitle) === 'Codex',
    'browser editor chat stage and deliver verify should expose the chat target',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'browser-editor-chat-delivery' &&
      output.delivered === true &&
      output.verified === true,
    'browser editor chat stage and deliver verify should expose final verified stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.browser.editor_chat_stage_and_deliver'),
    'browser editor chat stage and deliver verify should compose the staging chain',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('verified:Codex')),
    'browser editor chat stage and deliver verify should preserve verification evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Codex' &&
      chainState.currentArtifact === 'browser-editor-chat-delivery' &&
      chainState.chainStatus === 'completed',
    'browser editor chat stage and deliver verify should persist completed chat target chain state',
  )
}

async function verifyBrowserEditorChatStageAndDeliverVerifyFailsWhenBaseChainFails(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.browser.editor_chat_stage_and_deliver', ['editorAppName', 'chatAppName'], async input => ({
      ok: false,
      summary: `failed to deliver ${String(input.chatAppName)}`,
      data: {
        verification: {
          passed: false,
        },
        output: {
          extractedText: 'Need reply in chat',
          editorTargetWindowTitle: String(input.editorAppName),
          chatTargetWindowTitle: String(input.chatAppName),
          currentArtifact: 'browser-editor-chat-delivery',
        },
        chainState: {
          currentTarget: String(input.chatAppName),
          currentArtifact: 'browser-editor-chat-delivery',
          chainStatus: 'execution_failed',
        },
        recoveryPoint: `focus:${String(input.chatAppName)}`,
        verificationEvidence: ['stageTarget=Notepad', 'chatTarget=Codex'],
      },
      error: 'CHAT_DELIVERY_FAILED',
      failureClass: 'deterministic',
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.browser.editor_chat_stage_and_deliver_verify',
      input: {
        editorAppName: 'Notepad',
        chatAppName: 'Codex',
      },
    },
    createToolContext(),
  )

  assert(
    !result.ok,
    'browser editor chat stage and deliver verify should fail when the base chain fails',
  )
  const verification = readVerification(result.data)
  assert(
    verification?.passed === false,
    'browser editor chat stage and deliver verify failure should fail verification',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.browser.editor_chat_stage_and_deliver'),
    'browser editor chat stage and deliver verify failure should preserve the base template operation',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('chatTarget=Codex')),
    'browser editor chat stage and deliver verify failure should preserve base template evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Codex' &&
      chainState.currentArtifact === 'browser-editor-chat-delivery' &&
      chainState.chainStatus === 'execution_failed',
    'browser editor chat stage and deliver verify failure should surface execution_failed chain state',
  )
  const recoveryPoint = (result.data as { recoveryPoint?: unknown }).recoveryPoint
  assert(
    recoveryPoint === 'focus:Codex',
    'browser editor chat stage and deliver verify failure should surface focus recovery point',
  )
}

async function verifyFileBrowserRouteDeliver(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('command.workspace.read_text', ['path'], async input => ({
      ok: true,
      summary: `read ${String(input.path)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          path: String(input.path),
          startLine: 1,
          endLine: 2,
          lines: ['need reply', 'for wechat'],
        },
      },
    })),
    createStubTool('command.browser.inspect_dom', [], async () => ({
      ok: true,
      summary: 'browser inspect ok',
      data: {
        verification: {
          passed: true,
        },
        output: {
          observation: {
            summary: 'browser dom snapshot ok',
            windows: ['Browser'],
            focusedWindow: 'Browser',
            observationMode: 'dom',
            confidence: 0.92,
            anchors: ['WeChat thread', 'Browser'],
            raw: {
              dom: {
                selectedText: 'reply to WeChat customer',
                title: 'WeChat reply guide',
              },
            },
          },
        },
      },
    })),
    createStubTool(
      'skill.app.switch_collect_compare',
      ['primaryWindowTitle', 'secondaryWindowTitle'],
      async input => ({
        ok: true,
        summary: `compared ${String(input.primaryWindowTitle)} and ${String(input.secondaryWindowTitle)}`,
        data: {
          verification: {
            passed: true,
          },
          output: {
            primaryEvidence: ['content:codex task queue', 'anchor:Codex'],
            secondaryEvidence: ['content:wechat draft reply', 'anchor:WeChat', 'thread:wechat priority'],
            comparisonSummary: 'comparison=wechat draft reply vs codex task queue',
            identical: false,
          },
          verificationEvidence: ['comparison=wechat draft reply vs codex task queue'],
        },
      }),
    ),
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async input => ({
      ok: true,
      summary: `delivered ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: String(input.appName),
          currentArtifact: 'open-observe-act-verify',
          lastVerifiedAnchor: `verified:${String(input.appName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`verified:${String(input.appName)}`],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_route_deliver',
      input: {
        path: 'followup.txt',
        primaryWindowTitle: 'Codex',
        secondaryWindowTitle: 'WeChat',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'file browser route deliver should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'file browser route deliver should verify success',
  )
  const output = readOutput(result.data) as {
    transformedText?: string
    browserContextText?: string
    selectedWindowTitle?: string
    routeReason?: string
    currentStage?: string
    currentArtifact?: string
    delivered?: boolean
  }
  assert(
    output.transformedText === 'NEED REPLY\nFOR WECHAT',
    'file browser route deliver should preserve transformed file payload',
  )
  assert(
    output.browserContextText === 'reply to WeChat customer',
    'file browser route deliver should expose browser routing context text',
  )
  assert(
    typeof output.selectedWindowTitle === 'string' &&
      (output.selectedWindowTitle === 'Codex' ||
        output.selectedWindowTitle === 'WeChat') &&
      typeof output.routeReason === 'string' &&
      output.routeReason.toLowerCase().includes('wechat'),
    'file browser route deliver should expose a concrete selected target and route reasoning',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'followup.txt' &&
      output.delivered === true,
    'file browser route deliver should expose final template stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('command.workspace.read_text') &&
      operations.includes('command.browser.inspect_dom') &&
      operations.includes('skill.app.switch_collect_compare') &&
      operations.includes('skill.cross_app.open_observe_act_verify'),
    'file browser route deliver should compose file read, browser route, compare, and verified delivery stages',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('source=followup.txt')) &&
      evidence.some(item => item.includes('browserContext=')) &&
      evidence.some(item => item.includes('routeReason=')) &&
      evidence.some(item => item.includes('verified:WeChat')),
    'file browser route deliver should preserve source, browser, route, and verification evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === output.selectedWindowTitle &&
      chainState.chainStatus === 'completed',
    'file browser route deliver should persist completed final target chain state',
  )
}

async function verifyFileBrowserRouteDeliverVerify(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.file.browser_route_deliver', ['path', 'primaryWindowTitle', 'secondaryWindowTitle'], async input => ({
      ok: true,
      summary: `route delivered ${String(input.path)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          sourcePath: String(input.path),
          transformedText: 'NEED REPLY\nFOR WECHAT',
          browserContextText: 'reply to WeChat customer',
          selectedWindowTitle: 'WeChat',
          routeReason: 'routeQuery=wechat better match',
          delivered: true,
          currentStage: 'delivered',
        },
        chainState: {
          currentTarget: 'WeChat',
          currentArtifact: String(input.path),
          lastVerifiedAnchor: 'WeChat',
          chainStatus: 'completed',
        },
        verificationEvidence: ['source=followup.txt', 'verified:WeChat'],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_route_deliver_verify',
      input: {
        path: 'followup.txt',
        primaryWindowTitle: 'Codex',
        secondaryWindowTitle: 'WeChat',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'file browser route deliver verify should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'file browser route deliver verify should verify success',
  )
  const output = readOutput(result.data) as {
    transformedText?: string
    browserContextText?: string
    selectedWindowTitle?: string
    routeReason?: string
    currentStage?: string
    currentArtifact?: string
    delivered?: boolean
    verified?: boolean
  }
  assert(
    output.transformedText === 'NEED REPLY\nFOR WECHAT',
    'file browser route deliver verify should preserve transformed file payload',
  )
  assert(
    output.browserContextText === 'reply to WeChat customer',
    'file browser route deliver verify should expose browser routing context text',
  )
  assert(
    output.selectedWindowTitle === 'WeChat' &&
      typeof output.routeReason === 'string' &&
      output.routeReason.toLowerCase().includes('wechat'),
    'file browser route deliver verify should expose a concrete selected target and route reasoning',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'followup.txt' &&
      output.delivered === true &&
      output.verified === true,
    'file browser route deliver verify should expose final verified stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.file.browser_route_deliver'),
    'file browser route deliver verify should use the underlying route-deliver chain',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('verified:WeChat')),
    'file browser route deliver verify should preserve verification evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'WeChat' &&
      chainState.chainStatus === 'completed',
    'file browser route deliver verify should persist completed final target chain state',
  )
}

async function verifyFileBrowserRouteDeliverVerifyFailsWhenBaseChainFails(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.file.browser_route_deliver', ['path', 'primaryWindowTitle', 'secondaryWindowTitle'], async input => ({
      ok: false,
      summary: `route delivery failed ${String(input.path)}`,
      data: {
        verification: {
          passed: false,
        },
        output: {
          sourcePath: String(input.path),
          transformedText: 'NEED REPLY\nFOR WECHAT',
          selectedWindowTitle: 'WeChat',
          routeReason: 'routeQuery=wechat better match',
        },
        chainState: {
          currentTarget: 'WeChat',
          currentArtifact: String(input.path),
          chainStatus: 'execution_failed',
        },
        recoveryPoint: 'focus:WeChat',
        verificationEvidence: ['source=followup.txt', 'routeReason=routeQuery=wechat better match'],
      },
      error: 'ROUTE_DELIVERY_FAILED',
      failureClass: 'deterministic',
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_route_deliver_verify',
      input: {
        path: 'followup.txt',
        primaryWindowTitle: 'Codex',
        secondaryWindowTitle: 'WeChat',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(
    !result.ok,
    'file browser route deliver verify should fail when the base chain fails',
  )
  const verification = readVerification(result.data)
  assert(
    verification?.passed === false,
    'file browser route deliver verify failure should fail verification',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.file.browser_route_deliver'),
    'file browser route deliver verify failure should preserve the base template operation',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('routeReason=')),
    'file browser route deliver verify failure should preserve routing evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentArtifact === 'followup.txt' &&
      chainState.chainStatus === 'execution_failed',
    'file browser route deliver verify failure should surface execution_failed chain state',
  )
  const recoveryPoint = (result.data as { recoveryPoint?: unknown }).recoveryPoint
  assert(
    recoveryPoint === 'focus:WeChat',
    'file browser route deliver verify failure should surface focus recovery point',
  )
}

async function verifyFileBrowserChatRouteDeliver(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('command.workspace.read_text', ['path'], async input => ({
      ok: true,
      summary: `read ${String(input.path)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          path: String(input.path),
          startLine: 1,
          endLine: 2,
          lines: ['need reply', 'for chat'],
        },
      },
    })),
    createStubTool('command.browser.inspect_dom', [], async () => ({
      ok: true,
      summary: 'browser inspect ok',
      data: {
        verification: {
          passed: true,
        },
        output: {
          observation: {
            summary: 'browser dom snapshot ok',
            windows: ['Browser'],
            focusedWindow: 'Browser',
            observationMode: 'dom',
            confidence: 0.92,
            anchors: ['Codex chat thread', 'Browser'],
            raw: {
              dom: {
                selectedText: 'reply in Codex',
                title: 'Codex chat guide',
              },
            },
          },
        },
      },
    })),
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async input => ({
      ok: true,
      summary: `delivered ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: String(input.appName),
          currentArtifact: 'open-observe-act-verify',
          lastVerifiedAnchor: `verified:${String(input.appName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`verified:${String(input.appName)}`],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_chat_route_deliver',
      input: {
        path: 'followup.txt',
        chatAppName: 'Codex',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'file browser chat route deliver should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'file browser chat route deliver should verify success',
  )
  const output = readOutput(result.data) as {
    transformedText?: string
    browserContextText?: string
    selectedWindowTitle?: string
    routeReason?: string
    currentStage?: string
    currentArtifact?: string
    delivered?: boolean
  }
  assert(
    output.transformedText === 'NEED REPLY\nFOR CHAT',
    'file browser chat route deliver should preserve transformed file payload',
  )
  assert(
    output.browserContextText === 'reply in Codex',
    'file browser chat route deliver should expose browser routing context text',
  )
  assert(
    output.selectedWindowTitle === 'Codex' &&
      typeof output.routeReason === 'string' &&
      output.routeReason.toLowerCase().includes('codex'),
    'file browser chat route deliver should expose a concrete selected target and route reasoning',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'followup.txt' &&
      output.delivered === true,
    'file browser chat route deliver should expose final template stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('command.workspace.read_text') &&
      operations.includes('command.browser.inspect_dom') &&
      operations.includes('skill.cross_app.open_observe_act_verify'),
    'file browser chat route deliver should compose file read, browser route, and verified delivery stages',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('source=followup.txt')) &&
      evidence.some(item => item.includes('browserContext=')) &&
      evidence.some(item => item.includes('routeReason=')) &&
      evidence.some(item => item.includes('verified:Codex')),
    'file browser chat route deliver should preserve source, browser, route, and verification evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === output.selectedWindowTitle &&
      chainState.chainStatus === 'completed',
    'file browser chat route deliver should persist completed final target chain state',
  )
}

async function verifyFileBrowserChatRouteDeliverVerify(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.file.browser_chat_route_deliver', ['path', 'chatAppName'], async input => ({
      ok: true,
      summary: `chat route delivered ${String(input.path)}`,
      data: {
        verification: {
          passed: true,
        },
        output: {
          sourcePath: String(input.path),
          transformedText: 'NEED REPLY\nFOR CHAT',
          browserContextText: 'reply in Codex',
          selectedWindowTitle: 'Codex',
          routeReason: 'routeQuery=Codex',
          delivered: true,
          currentStage: 'delivered',
          currentArtifact: String(input.path),
        },
        chainState: {
          currentTarget: 'Codex',
          currentArtifact: String(input.path),
          lastVerifiedAnchor: 'Codex',
          chainStatus: 'completed',
        },
        verificationEvidence: ['source=followup.txt', 'verified:Codex'],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_chat_route_deliver_verify',
      input: {
        path: 'followup.txt',
        chatAppName: 'Codex',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'file browser chat route deliver verify should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'file browser chat route deliver verify should verify success',
  )
  const output = readOutput(result.data) as {
    transformedText?: string
    browserContextText?: string
    selectedWindowTitle?: string
    routeReason?: string
    currentStage?: string
    currentArtifact?: string
    delivered?: boolean
    verified?: boolean
  }
  assert(
    output.transformedText === 'NEED REPLY\nFOR CHAT',
    'file browser chat route deliver verify should preserve transformed file payload',
  )
  assert(
    output.browserContextText === 'reply in Codex',
    'file browser chat route deliver verify should expose browser routing context text',
  )
  assert(
    output.selectedWindowTitle === 'Codex' &&
      typeof output.routeReason === 'string' &&
      output.routeReason.toLowerCase().includes('codex'),
    'file browser chat route deliver verify should expose a concrete selected target and route reasoning',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'followup.txt' &&
      output.delivered === true &&
      output.verified === true,
    'file browser chat route deliver verify should expose final verified stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.file.browser_chat_route_deliver'),
    'file browser chat route deliver verify should use the underlying chat-route chain',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('verified:Codex')),
    'file browser chat route deliver verify should preserve verification evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Codex' &&
      chainState.chainStatus === 'completed',
    'file browser chat route deliver verify should persist completed final target chain state',
  )
}

async function verifyFileBrowserChatRouteDeliverVerifyFailsWhenBaseChainFails(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('skill.file.browser_chat_route_deliver', ['path', 'chatAppName'], async input => ({
      ok: false,
      summary: `chat route delivery failed ${String(input.path)}`,
      data: {
        verification: {
          passed: false,
        },
        output: {
          sourcePath: String(input.path),
          transformedText: 'NEED REPLY\nFOR CHAT',
          selectedWindowTitle: String(input.chatAppName),
          routeReason: 'routeQuery=Codex',
        },
        chainState: {
          currentTarget: String(input.chatAppName),
          currentArtifact: String(input.path),
          chainStatus: 'execution_failed',
        },
        recoveryPoint: 'focus:Codex',
        verificationEvidence: ['source=followup.txt', 'routeReason=routeQuery=Codex'],
      },
      error: 'CHAT_ROUTE_DELIVERY_FAILED',
      failureClass: 'deterministic',
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.file.browser_chat_route_deliver_verify',
      input: {
        path: 'followup.txt',
        chatAppName: 'Codex',
        transform: 'uppercase',
      },
    },
    createToolContext(),
  )

  assert(
    !result.ok,
    'file browser chat route deliver verify should fail when the base chain fails',
  )
  const verification = readVerification(result.data)
  assert(
    verification?.passed === false,
    'file browser chat route deliver verify failure should fail verification',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('skill.file.browser_chat_route_deliver'),
    'file browser chat route deliver verify failure should preserve the base template operation',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('routeReason=')),
    'file browser chat route deliver verify failure should preserve routing evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Codex' &&
      chainState.currentArtifact === 'followup.txt' &&
      chainState.chainStatus === 'execution_failed',
    'file browser chat route deliver verify failure should surface execution_failed chain state',
  )
  const recoveryPoint = (result.data as { recoveryPoint?: unknown }).recoveryPoint
  assert(
    recoveryPoint === 'focus:Codex',
    'file browser chat route deliver verify failure should surface focus recovery point',
  )
}

async function verifyCrossAppOpenObserveActVerifyRecoversFromFocusDrift(): Promise<void> {
  let transferAttempts = 0
  let observeAttempts = 0

  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('command.app.open_or_focus', ['appName'], async input => ({
      ok: true,
      summary: `focused ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('command.desktop.capture_and_locate', ['query'], async input => ({
      ok: true,
      summary: `captured ${String(input.query)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('skill.cross_app.transfer_text', ['text', 'targetWindowTitle'], async input => {
      transferAttempts += 1
      return {
        ok: true,
        summary: `transferred ${String(input.targetWindowTitle)} attempt=${transferAttempts}`,
        data: {
          verification: {
            passed: true,
          },
        },
      }
    }),
    createStubTool('windows.wait', ['durationSeconds'], async () => ({
      ok: true,
      summary: 'wait ok',
    })),
    createStubTool('skill.desktop.observe', [], async () => {
      observeAttempts += 1
      if (observeAttempts === 1) {
        return {
          ok: true,
          summary: 'observed wrong target',
          data: {
            verification: {
              passed: true,
            },
            chainState: {
              currentTarget: 'Other window',
              lastVerifiedAnchor: 'anchor:Other window',
              chainStatus: 'verified_failed',
            },
            verificationEvidence: ['focused=Other window'],
            recoveryPoint: 'focus:Notepad',
            output: {
              observation: {
                summary: 'observed wrong target',
                windows: ['Other window'],
                focusedWindow: 'Other window',
                observationMode: 'snapshot',
                confidence: 0.73,
                anchors: ['anchor:Other window'],
              },
            },
          },
        }
      }

      return {
        ok: true,
        summary: 'observed Notepad',
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: 'Notepad',
            lastVerifiedAnchor: 'anchor:Notepad',
            chainStatus: 'completed',
          },
          verificationEvidence: ['focused=Notepad', 'anchor:Notepad'],
          output: {
            observation: {
              summary: 'observed Notepad',
              windows: ['Notepad'],
              focusedWindow: 'Notepad',
              observationMode: 'snapshot',
              confidence: 0.94,
              anchors: ['anchor:Notepad'],
            },
          },
        },
      }
    }),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.cross_app.open_observe_act_verify',
      input: {
        appName: 'Notepad',
        targetWindowTitle: 'Notepad',
        text: 'hello from compuser',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'open observe act verify should recover from focus drift')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'open observe act verify recovery should verify success',
  )
  const operations = readOperations(result.data)
  assert(
    operations.filter(item => item === 'command.app.open_or_focus').length === 2,
    'open observe act verify should refocus and retry once',
  )
  assert(
    operations.filter(item => item === 'skill.cross_app.transfer_text').length === 2,
    'open observe act verify should rerun transfer after refocus',
  )
  assert(
    operations.filter(item => item === 'skill.desktop.observe').length === 2,
    'open observe act verify should rerun verification observe after refocus',
  )
  assert(
    transferAttempts === 2 && observeAttempts === 2,
    'open observe act verify recovery should retry transfer and verify once',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.chainStatus === 'completed',
    'open observe act verify recovery should finish on the target window',
  )
}

async function verifyOpenOrFocusShellRecovery(): Promise<void> {
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.focus_window', ['windowTitle'], async () => ({
      ok: false,
      summary: 'focus failed',
      error: 'WINDOW_FOCUS_FAILED',
      failureClass: 'deterministic',
    })),
    createStubTool('windows.shell', ['command'], async input => ({
      ok: true,
      summary: `shell launched ${String(input.command)}`,
    })),
    createStubTool('windows.wait', ['durationSeconds'], async () => ({
      ok: true,
      summary: 'wait ok',
    })),
    createStubTool('windows.snapshot', [], async () => ({
      ok: true,
      summary: 'snapshot ok',
      data: {
        summary: 'snapshot ok',
        windows: ['无标题 - 记事本'],
        focusedWindow: '无标题 - 记事本',
        observationMode: 'snapshot',
        confidence: 0.78,
        anchors: ['无标题 - 记事本'],
      },
    })),
    createStubTool('windows.app', ['mode'], async () => ({
      ok: false,
      summary: 'launch failed',
      error: 'WINDOW_APP_FAILED',
      failureClass: 'deterministic',
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'command.app.open_or_focus',
      input: {
        appName: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'open or focus should recover through shell launch')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'open or focus shell recovery should verify success',
  )
  const operations = readOperations(result.data)
  assert(
    operations.includes('windows.shell'),
    'open or focus shell recovery should expose backend shell launch',
  )
}

async function verifyAppSwitchCollectCompare(): Promise<void> {
  const focusCalls: string[] = []
  let observeCount = 0

  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.app', ['mode'], async input => {
      if (input.mode === 'list') {
        return {
          ok: true,
          summary: 'listed Browser, Notepad',
        }
      }

      if (input.mode === 'switch') {
        return {
          ok: true,
          summary: `switched ${String(input.name)}`,
        }
      }

      return {
        ok: false,
        summary: 'unexpected app mode',
        error: 'WINDOW_APP_FAILED',
        failureClass: 'deterministic',
      }
    }),
    createStubTool('windows.focus_window', ['windowTitle'], async input => {
      const title = String(input.windowTitle)
      focusCalls.push(title)
      return {
        ok: title !== 'Notepad',
        summary: title !== 'Notepad' ? `focused ${title}` : 'focus failed',
        error: title !== 'Notepad' ? undefined : 'WINDOW_FOCUS_FAILED',
        failureClass: title !== 'Notepad' ? undefined : 'deterministic',
      }
    }),
    createStubTool('skill.desktop.observe', [], async () => {
      observeCount += 1
      const isFirst = observeCount === 1
      return {
        ok: true,
        summary: `observe ${isFirst ? 'Browser' : 'Notepad'}`,
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: isFirst ? 'Browser' : 'Notepad',
            lastVerifiedAnchor: isFirst ? 'anchor:Browser' : 'anchor:Notepad',
            chainStatus: 'completed',
          },
          verificationEvidence: isFirst
            ? ['anchor:Browser', 'content:Alpha']
            : ['anchor:Notepad', 'content:Beta'],
          output: {
            observation: {
              summary: `observe ${isFirst ? 'Browser' : 'Notepad'}`,
              windows: [isFirst ? 'Browser' : 'Notepad'],
              focusedWindow: isFirst ? 'Browser' : 'Notepad',
              observationMode: 'snapshot',
              confidence: 0.91,
              anchors: [isFirst ? 'Alpha heading' : 'Beta note'],
            },
          },
        },
      }
    }),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.app.switch_collect_compare',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'app switch collect compare should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'app switch collect compare should verify success',
  )
  const output = readOutput(result.data) as {
    primaryEvidence?: string[]
    secondaryEvidence?: string[]
    comparisonSummary?: string
    identical?: boolean
  }
  assert(
    output.identical === false,
    'app switch collect compare should report non-identical evidence',
  )
  assert(
    typeof output.comparisonSummary === 'string' &&
      output.comparisonSummary.includes('comparison='),
    'app switch collect compare should emit a comparison summary',
  )
  assert(
    Array.isArray(output.primaryEvidence) &&
      output.primaryEvidence.some(item => item.includes('content:Alpha')),
    'app switch collect compare should preserve primary evidence',
  )
  assert(
    Array.isArray(output.secondaryEvidence) &&
      output.secondaryEvidence.some(item => item.includes('content:Beta')),
    'app switch collect compare should preserve secondary evidence',
  )
  const operations = readOperations(result.data)
  assert(
    operations.filter(item => item === 'skill.desktop.observe').length === 2,
    'app switch collect compare should observe each target window',
  )
  assert(
    operations.includes('windows.app'),
    'app switch collect compare should expose windows.app list/switch usage',
  )
  assert(
    focusCalls.join(',') === 'Browser,Notepad',
    'app switch collect compare should attempt both target focuses in order',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('comparison=')),
    'app switch collect compare should include comparison evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.chainStatus === 'completed',
    'app switch collect compare should persist completed chain state',
  )
}

async function verifyMultiWindowObserveRouteExecute(): Promise<void> {
  const openCalls: string[] = []
  let observeCount = 0

  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.app', ['mode'], async input => {
      if (input.mode === 'list') {
        return {
          ok: true,
          summary: 'listed Browser, Notepad',
        }
      }

      if (input.mode === 'switch') {
        return {
          ok: true,
          summary: `switched ${String(input.name)}`,
        }
      }

      return {
        ok: false,
        summary: 'unexpected app mode',
        error: 'WINDOW_APP_FAILED',
        failureClass: 'deterministic',
      }
    }),
    createStubTool('windows.focus_window', ['windowTitle'], async input => ({
      ok: true,
      summary: `focused ${String(input.windowTitle)}`,
    })),
    createStubTool('skill.desktop.observe', [], async () => {
      observeCount += 1
      const isFirst = observeCount === 1
      return {
        ok: true,
        summary: `observe ${isFirst ? 'Browser' : 'Notepad'}`,
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: isFirst ? 'Browser' : 'Notepad',
            lastVerifiedAnchor: isFirst ? 'anchor:Browser' : 'anchor:Notepad',
            chainStatus: 'completed',
          },
          verificationEvidence: isFirst
            ? ['content:shopping cart', 'anchor:Browser']
            : ['content:meeting note', 'anchor:Notepad'],
          output: {
            observation: {
              summary: `observe ${isFirst ? 'Browser' : 'Notepad'}`,
              windows: [isFirst ? 'Browser' : 'Notepad'],
              focusedWindow: isFirst ? 'Browser' : 'Notepad',
              observationMode: 'snapshot',
              confidence: 0.93,
              anchors: [isFirst ? 'shopping cart' : 'meeting note'],
            },
          },
        },
      }
    }),
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async input => {
      openCalls.push(String(input.appName))
      return {
        ok: true,
        summary: `executed ${String(input.appName)}`,
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: String(input.appName),
            lastVerifiedAnchor: `verified:${String(input.appName)}`,
            chainStatus: 'completed',
          },
          verificationEvidence: [`verified:${String(input.appName)}`],
        },
      }
    }),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.multi_window.observe_route_execute',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'meeting',
        actionText: 'follow up',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'multi window observe route execute should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'multi window observe route execute should verify success',
  )
  const output = readOutput(result.data) as {
    selectedWindowTitle?: string
    routeReason?: string
    executed?: boolean
    verified?: boolean
  }
  assert(
    output.selectedWindowTitle === 'Notepad',
    'multi window observe route execute should route to the better matching target',
  )
  assert(
    typeof output.routeReason === 'string' &&
      output.routeReason.includes('routeQuery=meeting'),
    'multi window observe route execute should explain its route choice',
  )
  assert(
    output.executed === true && output.verified === true,
    'multi window observe route execute should report executed and verified success',
  )
  const operations = readOperations(result.data)
  assert(
    operations.filter(item => item === 'skill.desktop.observe').length === 2,
    'multi window observe route execute should observe both candidate windows',
  )
  assert(
    operations.includes('skill.cross_app.open_observe_act_verify'),
    'multi window observe route execute should use the downstream execution chain',
  )
  assert(
    openCalls.join(',') === 'Notepad',
    'multi window observe route execute should execute only against the selected target',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('routeReason=')) &&
      evidence.some(item => item.includes('content:meeting note')),
    'multi window observe route execute should preserve routing evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.chainStatus === 'completed',
    'multi window observe route execute should persist selected target chain state',
  )
}

async function verifyMultiWindowObserveRouteExecuteRecoversFromFocusDrift(): Promise<void> {
  const executeCalls: string[] = []
  let observeCount = 0

  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.app', ['mode'], async input => {
      if (input.mode === 'list') {
        return {
          ok: true,
          summary: 'listed Browser, Notepad',
        }
      }

      if (input.mode === 'switch') {
        return {
          ok: true,
          summary: `switched ${String(input.name)}`,
        }
      }

      return {
        ok: false,
        summary: 'unexpected app mode',
        error: 'WINDOW_APP_FAILED',
        failureClass: 'deterministic',
      }
    }),
    createStubTool('windows.focus_window', ['windowTitle'], async input => ({
      ok: true,
      summary: `focused ${String(input.windowTitle)}`,
    })),
    createStubTool('skill.desktop.observe', [], async () => {
      observeCount += 1
      const isFirst = observeCount === 1
      return {
        ok: true,
        summary: `observe ${isFirst ? 'Browser' : 'Notepad'}`,
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: isFirst ? 'Browser' : 'Notepad',
            lastVerifiedAnchor: isFirst ? 'anchor:Browser' : 'anchor:Notepad',
            chainStatus: 'completed',
          },
          verificationEvidence: isFirst
            ? ['content:shopping cart', 'anchor:Browser']
            : ['content:meeting note', 'anchor:Notepad'],
          output: {
            observation: {
              summary: `observe ${isFirst ? 'Browser' : 'Notepad'}`,
              windows: [isFirst ? 'Browser' : 'Notepad'],
              focusedWindow: isFirst ? 'Browser' : 'Notepad',
              observationMode: 'snapshot',
              confidence: 0.93,
              anchors: [isFirst ? 'shopping cart' : 'meeting note'],
            },
          },
        },
      }
    }),
    createStubTool('command.app.open_or_focus', ['appName'], async input => ({
      ok: true,
      summary: `refocused ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
      },
    })),
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async input => {
      executeCalls.push(String(input.appName))
      if (executeCalls.length === 1) {
        return {
          ok: false,
          summary: 'focus drift detected',
          data: {
            verification: {
              passed: false,
            },
            chainState: {
              currentTarget: String(input.appName),
              lastVerifiedAnchor: `anchor:${String(input.appName)}`,
              chainStatus: 'verified_failed',
            },
            recoveryPoint: `focus:${String(input.appName)}`,
            verificationEvidence: ['focus drift detected'],
          },
          failureClass: 'deterministic',
        }
      }

      return {
        ok: true,
        summary: `executed ${String(input.appName)} after recovery`,
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: String(input.appName),
            lastVerifiedAnchor: `verified:${String(input.appName)}`,
            chainStatus: 'completed',
          },
          verificationEvidence: [`verified:${String(input.appName)}`],
          recoveryUsed: true,
        },
      }
    }),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.multi_window.observe_route_execute',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'meeting',
        actionText: 'follow up',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'multi window observe route execute should recover from focus drift')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'multi window observe route execute recovery should verify success',
  )
  const operations = readOperations(result.data)
  assert(
    operations.filter(item => item === 'skill.cross_app.open_observe_act_verify').length === 2,
    'multi window observe route execute should retry execution after recovery',
  )
  assert(
    operations.includes('command.app.open_or_focus'),
    'multi window observe route execute should refocus before retrying',
  )
  assert(
    executeCalls.join(',') === 'Notepad,Notepad',
    'multi window observe route execute should retry the same selected target',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('verified:Notepad')),
    'multi window observe route execute recovery should preserve post-recovery evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.chainStatus === 'completed',
    'multi window observe route execute recovery should finish completed',
  )
}

async function verifyMultiWindowObserveRouteDeliverVerify(): Promise<void> {
  let observeCount = 0
  const runtime = createRuntimeWithCapabilityTools([
    createStubTool('windows.app', ['mode'], async input => {
      if (input.mode === 'list') {
        return {
          ok: true,
          summary: 'listed Browser, Notepad',
        }
      }

      return {
        ok: false,
        summary: 'unexpected app mode',
        error: 'WINDOW_APP_FAILED',
        failureClass: 'deterministic',
      }
    }),
    createStubTool('windows.focus_window', ['windowTitle'], async input => ({
      ok: true,
      summary: `focused ${String(input.windowTitle)}`,
    })),
    createStubTool('skill.desktop.observe', [], async () => {
      observeCount += 1
      const isFirst = observeCount === 1
      return {
        ok: true,
        summary: `observe ${isFirst ? 'Browser' : 'Notepad'}`,
        data: {
          verification: {
            passed: true,
          },
          chainState: {
            currentTarget: isFirst ? 'Browser' : 'Notepad',
            lastVerifiedAnchor: isFirst ? 'anchor:Browser' : 'anchor:Notepad',
            chainStatus: 'completed',
          },
          verificationEvidence: isFirst
            ? ['content:browser draft', 'anchor:Browser']
            : ['content:meeting note', 'anchor:Notepad'],
        },
      }
    }),
    createStubTool('skill.cross_app.open_observe_act_verify', ['appName'], async input => ({
      ok: true,
      summary: `delivered ${String(input.appName)}`,
      data: {
        verification: {
          passed: true,
        },
        chainState: {
          currentTarget: String(input.appName),
          lastVerifiedAnchor: `verified:${String(input.appName)}`,
          chainStatus: 'completed',
        },
        verificationEvidence: [`verified:${String(input.appName)}`],
      },
    })),
  ])

  const result = await runtime.execute(
    {
      toolName: 'skill.multi_window.observe_route_deliver_verify',
      input: {
        primaryWindowTitle: 'Browser',
        secondaryWindowTitle: 'Notepad',
        routeQuery: 'meeting',
        targetAppName: 'Notepad',
        targetWindowTitle: 'Notepad',
        actionText: 'follow up',
      },
    },
    createToolContext(),
  )

  assert(result.ok, 'multi window observe route deliver verify should succeed')
  const verification = readVerification(result.data)
  assert(
    verification?.passed === true,
    'multi window observe route deliver verify should verify success',
  )
  const output = readOutput(result.data) as {
    selectedWindowTitle?: string
    routeReason?: string
    currentStage?: string
    currentArtifact?: string
    executed?: boolean
    verified?: boolean
  }
  assert(
    output.selectedWindowTitle === 'Notepad',
    'multi window observe route deliver verify should route to the better matching target',
  )
  assert(
    output.currentStage === 'verified' &&
      output.currentArtifact === 'multi-window-observe-route-deliver-verify' &&
      output.executed === true &&
      output.verified === true,
    'multi window observe route deliver verify should expose verified stage and artifact',
  )
  const operations = readOperations(result.data)
  assert(
    operations.filter(item => item === 'skill.desktop.observe').length === 2,
    'multi window observe route deliver verify should observe both candidate windows',
  )
  assert(
    operations.includes('skill.cross_app.open_observe_act_verify'),
    'multi window observe route deliver verify should use the downstream delivery chain',
  )
  const evidence = readEvidence(result.data)
  assert(
    evidence.some(item => item.includes('verified:Notepad')),
    'multi window observe route deliver verify should preserve verification evidence',
  )
  const chainState = readChainState(result.data)
  assert(
    chainState?.currentTarget === 'Notepad' &&
      chainState.chainStatus === 'completed',
    'multi window observe route deliver verify should persist selected target chain state',
  )
}

function createRuntimeWithCapabilityTools(
  stubs: AnyStubTool[],
): ToolRuntime {
  const registry = new InMemoryToolRegistry()
  const runtime = new ToolRuntime(registry, new AllowAllPermissionChecker())
  const capabilityCatalog = new InMemoryCapabilityCatalog(createBuiltinCapabilities())
  for (const tool of createCapabilityTools({
    catalog: capabilityCatalog,
    runtime,
  })) {
    registry.register(tool)
  }
  for (const stub of stubs) {
    registry.register(stub)
  }

  return runtime
}

type AnyStubTool = ToolDefinition<Record<string, unknown>, unknown>

function createStubTool(
  name: string,
  requiredKeys: string[],
  execute: ToolDefinition<Record<string, unknown>, unknown>['execute'],
): AnyStubTool {
  return {
    name,
    availability: 'core',
    description: `${name} regression stub`,
    searchHints: [name, 'regression', 'stub'],
    riskLevel: 'low',
    executionMode: 'sync',
    concurrencySafe: true,
    inputSchema: {
      description: `${name} input`,
      properties: Object.fromEntries(
        requiredKeys.map(key => [key, { type: 'string' }]),
      ),
      required: requiredKeys,
    },
    execute,
  }
}

function createToolContext() {
  return {
    cwd: CLI_WORKSPACE_ROOT,
    sessionId: 'phase2-chain-regression',
    turnId: 'turn-1',
  }
}

function readVerification(data: unknown):
  | {
      passed?: boolean
      strategy?: string
      details?: string
    }
  | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  return (data as { verification?: unknown }).verification as
    | {
        passed?: boolean
        strategy?: string
        details?: string
      }
    | undefined
}

function readOutput(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  return (data as { output?: unknown }).output
}

function readChainState(data: unknown):
  | {
      currentTarget?: string
      currentArtifact?: string
      chainStatus?: string
    }
  | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  return (data as { chainState?: unknown }).chainState as
    | {
        currentTarget?: string
        currentArtifact?: string
        chainStatus?: string
      }
    | undefined
}

function readEvidence(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const evidence = (data as { verificationEvidence?: unknown }).verificationEvidence
  return Array.isArray(evidence)
    ? evidence.filter((value): value is string => typeof value === 'string')
    : []
}

function readOperations(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) {
    return []
  }

  const operations = (data as { operations?: unknown }).operations
  return Array.isArray(operations)
    ? operations
        .map(operation =>
          typeof operation === 'object' &&
          operation !== null &&
          typeof (operation as { target?: unknown }).target === 'string'
            ? ((operation as { target?: string }).target as string)
            : undefined,
        )
        .filter((value): value is string => Boolean(value))
    : []
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
