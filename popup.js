// DOM Elements
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const maxConcurrentEl = document.getElementById('maxConcurrent');
const saveSettingsBtn = document.getElementById('saveSettings');
const startDownloadBtn = document.getElementById('startDownload');
const refreshTabsBtn = document.getElementById('refreshTabs');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const logContainer = document.getElementById('logContainer');

// State
let rapidgatorTabs = [];
let isDownloading = false;
let downloadStates = new Map(); // tabId -> state

// State constants (mirror background.js)
const STATE = {
    PENDING: 'pending',
    CLICKED: 'clicked',
    DOWNLOADING: 'downloading',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await findRapidgatorTabs();
    await syncStatesFromBackground();
    setupMessageListener();
});

// Event Listeners
saveSettingsBtn.addEventListener('click', saveSettings);
startDownloadBtn.addEventListener('click', startDownload);
refreshTabsBtn.addEventListener('click', findRapidgatorTabs);

// =============================================================================
// Background Communication
// =============================================================================

/**
 * Listen for messages from background script
 */
function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.event) {
            case 'downloadStarted':
                handleDownloadStarted(message.tabId, message.downloadId);
                break;
            case 'downloadCompleted':
                handleDownloadCompleted(message.tabId);
                break;
            case 'downloadFailed':
                handleDownloadFailed(message.tabId, message.reason);
                break;
            case 'tabClosed':
                handleTabClosed(message.tabId);
                break;
        }
    });
}

/**
 * Sync states from background script
 */
async function syncStatesFromBackground() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getStates' });
        if (response && response.states) {
            downloadStates.clear();
            response.states.forEach(state => {
                downloadStates.set(state.tabId, state);
            });
            updateUI();
        }
    } catch (error) {
        // Background might not have any states yet
    }
}

// =============================================================================
// Event Handlers from Background
// =============================================================================

function handleDownloadStarted(tabId, downloadId) {
    const state = downloadStates.get(tabId);
    if (state) {
        state.state = STATE.DOWNLOADING;
        state.downloadId = downloadId;
        log(`DL開始確認: ${state.fileName}`, 'success');
        updateUI();
    }
}

function handleDownloadCompleted(tabId) {
    const state = downloadStates.get(tabId);
    if (state) {
        state.state = STATE.COMPLETED;
        log(`完了: ${state.fileName}`, 'success');
        updateUI();
        checkAllCompleted();
    }
}

function handleDownloadFailed(tabId, reason) {
    const state = downloadStates.get(tabId);
    if (state) {
        state.state = STATE.FAILED;
        state.error = reason;
        log(`失敗: ${state.fileName} - ${reason}`, 'error');
        updateUI();
        checkAllCompleted();
    }
}

function handleTabClosed(tabId) {
    const state = downloadStates.get(tabId);
    if (state) {
        log(`タブを閉じました: ${state.fileName}`, 'info');
    }
}

// =============================================================================
// Settings
// =============================================================================

async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(['maxConcurrent']);
        if (result.maxConcurrent) {
            maxConcurrentEl.value = result.maxConcurrent;
        }
    } catch (error) {
        log('設定の読み込みに失敗', 'error');
    }
}

async function saveSettings() {
    const value = parseInt(maxConcurrentEl.value, 10);
    if (value < 1 || value > 50) {
        log('最大同時ダウンロード数は1〜50の間で設定してください', 'error');
        return;
    }
    try {
        await chrome.storage.local.set({ maxConcurrent: value });
        log(`設定を保存しました: 最大 ${value} 件`, 'success');
    } catch (error) {
        log('設定の保存に失敗', 'error');
    }
}

// =============================================================================
// Tab Discovery
// =============================================================================

async function findRapidgatorTabs() {
    try {
        statusEl.textContent = '検索中...';

        const tabs = await chrome.tabs.query({});
        rapidgatorTabs = tabs.filter(tab => {
            if (!tab.url) return false;
            const url = new URL(tab.url);
            return url.hostname === 'rapidgator.net' || url.hostname.endsWith('.rapidgator.net');
        });

        countEl.textContent = rapidgatorTabs.length;

        if (rapidgatorTabs.length === 0) {
            statusEl.textContent = 'Rapidgatorのタブが見つかりません';
            startDownloadBtn.disabled = true;
        } else {
            statusEl.textContent = `${rapidgatorTabs.length} 件のタブを検出`;
            startDownloadBtn.disabled = false;

            rapidgatorTabs.forEach(tab => {
                const fileName = extractFileName(tab.url);
                log(`検出: ${fileName || tab.url}`, 'info');
            });
        }
    } catch (error) {
        statusEl.textContent = 'エラーが発生しました';
        log(`エラー: ${error.message}`, 'error');
    }
}

function extractFileName(url) {
    try {
        const urlObj = new URL(url);
        const parts = urlObj.pathname.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.includes('.')) {
            return decodeURIComponent(lastPart.replace('.html', ''));
        }
        return null;
    } catch {
        return null;
    }
}

// =============================================================================
// Download Process
// =============================================================================

async function startDownload() {
    if (isDownloading) return;
    if (rapidgatorTabs.length === 0) {
        log('ダウンロード対象のタブがありません', 'error');
        return;
    }

    isDownloading = true;
    startDownloadBtn.disabled = true;
    refreshTabsBtn.disabled = true;

    // Clear previous states in background
    await chrome.runtime.sendMessage({ action: 'clearStates' });
    downloadStates.clear();

    const maxConcurrent = parseInt(maxConcurrentEl.value, 10) || 10;
    const totalTabs = rapidgatorTabs.length;

    // Show progress section
    progressSection.style.display = 'block';
    updateProgress(0, totalTabs);

    log(`ダウンロード開始: ${totalTabs} 件 (最大同時 ${maxConcurrent} 件)`, 'info');

    // Initialize states for all tabs
    rapidgatorTabs.forEach(tab => {
        downloadStates.set(tab.id, {
            tabId: tab.id,
            url: tab.url,
            fileName: extractFileName(tab.url) || `タブ ${tab.id}`,
            state: STATE.PENDING
        });
    });

    // Process tabs with concurrency limit
    let currentIndex = 0;
    let activeDownloads = 0;

    const processNext = async () => {
        while (currentIndex < totalTabs && activeDownloads < maxConcurrent) {
            const tab = rapidgatorTabs[currentIndex];
            currentIndex++;
            activeDownloads++;

            const state = downloadStates.get(tab.id);
            log(`処理中: ${state.fileName}`, 'info');

            try {
                // Send to background for processing
                const response = await chrome.runtime.sendMessage({
                    action: 'startDownload',
                    tab: { id: tab.id, url: tab.url }
                });

                if (response.success) {
                    state.state = STATE.CLICKED;
                    log(`クリック完了: ${state.fileName} (DL開始待機中...)`, 'info');
                } else {
                    state.state = STATE.FAILED;
                    state.error = response.error;
                    log(`失敗: ${state.fileName} - ${response.error}`, 'error');
                }
            } catch (error) {
                state.state = STATE.FAILED;
                state.error = error.message;
                log(`失敗: ${state.fileName} - ${error.message}`, 'error');
            }

            downloadStates.set(tab.id, state);
            updateUI();
            activeDownloads--;

            // Small delay between starting downloads
            await sleep(500);

            // Continue processing
            processNext();
        }
    };

    // Start initial batch
    processNext();
}

// =============================================================================
// Retry Failed Downloads
// =============================================================================

async function retryFailed(tabId) {
    const state = downloadStates.get(tabId);
    if (!state || state.state !== STATE.FAILED) return;

    log(`再試行: ${state.fileName}`, 'info');

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'retryFailed',
            tabId: tabId
        });

        if (response.success) {
            state.state = STATE.CLICKED;
            state.error = null;
            downloadStates.set(tabId, state);
            log(`再試行開始: ${state.fileName}`, 'info');
        } else {
            log(`再試行失敗: ${state.fileName} - ${response.error}`, 'error');
        }
    } catch (error) {
        log(`再試行失敗: ${state.fileName} - ${error.message}`, 'error');
    }

    updateUI();
}

// =============================================================================
// UI Updates
// =============================================================================

function updateUI() {
    const states = Array.from(downloadStates.values());
    const completed = states.filter(s => s.state === STATE.COMPLETED).length;
    const failed = states.filter(s => s.state === STATE.FAILED).length;
    const total = states.length;

    updateProgress(completed, total);

    // Update status text
    if (failed > 0) {
        statusEl.textContent = `${completed}/${total} 完了 (${failed} 件失敗)`;
    } else if (completed === total && total > 0) {
        statusEl.textContent = 'すべてのダウンロードが完了しました';
    } else {
        statusEl.textContent = `処理中: ${completed}/${total}`;
    }
}

function updateProgress(current, total) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${current} / ${total} 完了`;
}

function checkAllCompleted() {
    const states = Array.from(downloadStates.values());
    const pending = states.filter(s =>
        s.state === STATE.PENDING ||
        s.state === STATE.CLICKED ||
        s.state === STATE.DOWNLOADING
    );

    if (pending.length === 0 && states.length > 0) {
        finishDownload();
    }
}

function finishDownload() {
    isDownloading = false;
    startDownloadBtn.disabled = false;
    refreshTabsBtn.disabled = false;

    const states = Array.from(downloadStates.values());
    const failed = states.filter(s => s.state === STATE.FAILED);

    if (failed.length > 0) {
        log(`完了: ${failed.length} 件のダウンロードが失敗しました。再試行可能です。`, 'error');
        // Add retry prompt
        failed.forEach(state => {
            log(`  → [再試行] ${state.fileName}`, 'error');
        });
    } else {
        log('すべてのダウンロードが完了しました', 'success');
    }
}

// =============================================================================
// Utility Functions
// =============================================================================

function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logContainer.insertBefore(entry, logContainer.firstChild);

    // Keep only last 50 entries
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
