import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { PanelAttachment } from './taskSubmission.js'

export interface SavedPanelAttachment {
  name: string
  mimeType: string
  absolutePath: string
  relativePath: string
}

export async function buildTaskWithAttachments(input: {
  task: string
  attachments: PanelAttachment[]
  sessionId: string
  uploadsRoot: string
  workspaceRoot: string
}): Promise<string> {
  if (!input.attachments.length) {
    return input.task
  }

  const savedFiles = await Promise.all(
    input.attachments.map((attachment, index) =>
      savePanelAttachment({
        attachment,
        sessionId: input.sessionId,
        index,
        uploadsRoot: input.uploadsRoot,
        workspaceRoot: input.workspaceRoot,
      }),
    ),
  )
  const intro = input.task || '请基于我上传的文件继续完成任务。'
  const attachmentLines = savedFiles.map(
    file => `- ${file.name} | ${file.mimeType} | ${file.relativePath}`,
  )

  return [
    intro,
    '',
    '已上传文件：',
    ...attachmentLines,
    '',
    '处理要求：优先读取以上文件，并把这些文件内容纳入本次任务上下文。',
  ].join('\n')
}

async function savePanelAttachment(input: {
  attachment: PanelAttachment
  sessionId: string
  index: number
  uploadsRoot: string
  workspaceRoot: string
}): Promise<SavedPanelAttachment> {
  const safeName = sanitizeUploadFileName(input.attachment.name, input.index)
  const stampedName = `${Date.now()}-${input.index}-${safeName}`
  const sessionDir = resolve(input.uploadsRoot, input.sessionId)
  const targetPath = resolve(sessionDir, stampedName)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(targetPath, Buffer.from(input.attachment.base64, 'base64'))

  return {
    name: input.attachment.name,
    mimeType: input.attachment.mimeType,
    absolutePath: targetPath,
    relativePath: targetPath.replace(`${input.workspaceRoot}\\`, ''),
  }
}

function sanitizeUploadFileName(name: string, index: number): string {
  const baseName = basename(name).replace(/[^\w.\-()\[\] ]+/g, '_').trim()
  if (baseName) {
    return baseName
  }

  const extension = extname(name)
  return `upload-${index}${extension || '.bin'}`
}
