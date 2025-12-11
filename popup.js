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

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await findRapidgatorTabs();
});

// Event Listeners
saveSettingsBtn.addEventListener('click', saveSettings);
startDownloadBtn.addEventListener('click', startDownload);
refreshTabsBtn.addEventListener('click', findRapidgatorTabs);

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

    const maxConcurrent = parseInt(maxConcurrentEl.value, 10) || 3;
    const totalTabs = rapidgatorTabs.length;
    let completed = 0;
    let failed = 0;
    let currentIndex = 0;
    let activeSlots = 0;

    // Show progress section
    progressSection.style.display = 'block';
    updateProgress(0, totalTabs);

    log(`ダウンロード開始: ${totalTabs} 件 (最大同時 ${maxConcurrent} 件)`, 'info');

    // Process a single tab (returns when download starts or fails)
    const processSingleTab = async (tab) => {
        const fileName = extractFileName(tab.url) || `タブ ${tab.id}`;
        log(`処理中: ${fileName}`, 'info');

        try {
            // Send to background - this waits until download starts or timeout
            const response = await chrome.runtime.sendMessage({
                action: 'processTab',
                tab: { id: tab.id, url: tab.url }
            });

            if (response.success) {
                log(`✓ 完了: ${fileName} (タブを閉じました)`, 'success');
                completed++;
            } else {
                log(`✗ 失敗: ${fileName} - ${response.error}`, 'error');
                failed++;
            }
        } catch (error) {
            log(`✗ 失敗: ${fileName} - ${error.message}`, 'error');
            failed++;
        }

        updateProgress(completed, totalTabs);
        statusEl.textContent = `処理中: ${completed + failed}/${totalTabs} (成功: ${completed}, 失敗: ${failed})`;
    };

    // Process with concurrency control
    const processNext = async () => {
        while (currentIndex < totalTabs && activeSlots < maxConcurrent) {
            const tab = rapidgatorTabs[currentIndex];
            currentIndex++;
            activeSlots++;

            // Process this tab (async, but we track activeSlots)
            processSingleTab(tab).then(() => {
                activeSlots--;
                // Try to process more
                processNext();
            });

            // Small delay between starting new downloads
            await sleep(300);
        }

        // Check if all done
        if (completed + failed >= totalTabs) {
            finishDownload(completed, failed, totalTabs);
        }
    };

    // Start processing
    processNext();
}

function finishDownload(completed, failed, total) {
    isDownloading = false;
    startDownloadBtn.disabled = false;
    refreshTabsBtn.disabled = false;

    if (failed > 0) {
        statusEl.textContent = `完了: ${completed}/${total} 成功 (${failed} 件失敗)`;
        log(`処理完了: ${completed} 件成功、${failed} 件失敗`, 'error');
    } else {
        statusEl.textContent = `すべてのダウンロードが完了しました (${completed} 件)`;
        log(`すべてのダウンロードが完了しました (${completed} 件)`, 'success');
    }
}

// =============================================================================
// UI Utilities
// =============================================================================

function updateProgress(current, total) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${current} / ${total} 完了`;
}

function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logContainer.insertBefore(entry, logContainer.firstChild);

    // Keep only last 100 entries
    while (logContainer.children.length > 100) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
