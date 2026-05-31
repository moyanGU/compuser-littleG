import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { WindowsMcpService } from '../../packages/adapters/windows-mcp/WindowsMcpService.js';
import { PRODUCT_GOVERNANCE_VIEW } from '../../packages/product/ProductGovernance.js';
import {
    PANEL_DEFAULT_SESSION_ID,
    PANEL_UPLOADS_DIR,
    PRODUCT_SCORECARD_SUMMARY_PATH,
} from './defaults.js';
import { respondJson } from './httpTypes.js';
import { parseWebPanelArgs } from './serverOptions.js';
import { mapServiceStatus } from './serviceStatus.js';
import { handleWebPanelRequest } from './requestDispatcher.js';
import { createWebPanelRuntime } from './serverRuntime.js';

async function main() {
    const options = parseWebPanelArgs(process.argv.slice(2));
    const runtime = await createWebPanelRuntime(options, {
        readWindowsMcpStatus,
        readScorecardSummary,
        buildGovernanceView,
        mapRestartStatus: mapServiceStatus,
        panelDefaultSessionId: PANEL_DEFAULT_SESSION_ID,
        uploadsDir: PANEL_UPLOADS_DIR,
    });

    const server = createServer(async (request, response) => {
        try {
            await handleWebPanelRequest(
                request,
                response,
                options,
                runtime,
            );
        }
        catch (error) {
            respondJson(response, 500, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });

    server.listen(options.port, '127.0.0.1', () => {
        console.log(`web-panel listening on http://127.0.0.1:${options.port}`);
    });
}

async function readWindowsMcpStatus(windowsMcpService: WindowsMcpService) {
    const status = await windowsMcpService.healthcheck();
    return mapServiceStatus(status);
}

async function readScorecardSummary() {
    try {
        const raw = await readFile(PRODUCT_SCORECARD_SUMMARY_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}

function buildGovernanceView() {
    return PRODUCT_GOVERNANCE_VIEW;
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
