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

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await findRapidgatorTabs();
});

// Event Listeners
saveSettingsBtn.addEventListener('click', saveSettings);
startDownloadBtn.addEventListener('click', startDownload);
refreshTabsBtn.addEventListener('click', findRapidgatorTabs);

// Load saved settings
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

// Save settings
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

// Find Rapidgator tabs
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

            // Log found tabs
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

// Extract filename from URL
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

// Start download process
async function startDownload() {
    if (isDownloading) return;
    if (rapidgatorTabs.length === 0) {
        log('ダウンロード対象のタブがありません', 'error');
        return;
    }

    isDownloading = true;
    startDownloadBtn.disabled = true;
    refreshTabsBtn.disabled = true;

    const maxConcurrent = parseInt(maxConcurrentEl.value, 10) || 10;
    const totalTabs = rapidgatorTabs.length;
    let completed = 0;
    let currentIndex = 0;
    let activeDownloads = 0;

    // Show progress section
    progressSection.style.display = 'block';
    updateProgress(0, totalTabs);

    log(`ダウンロード開始: ${totalTabs} 件 (最大同時 ${maxConcurrent} 件)`, 'info');

    // Process tabs with concurrency limit
    const processNext = async () => {
        while (currentIndex < totalTabs && activeDownloads < maxConcurrent) {
            const tab = rapidgatorTabs[currentIndex];
            currentIndex++;
            activeDownloads++;

            const fileName = extractFileName(tab.url) || `タブ ${tab.id}`;
            log(`処理中: ${fileName}`, 'info');

            try {
                await clickDownloadButton(tab);
                log(`成功: ${fileName}`, 'success');
            } catch (error) {
                log(`失敗: ${fileName} - ${error.message}`, 'error');
            }

            completed++;
            activeDownloads--;
            updateProgress(completed, totalTabs);

            // Small delay between starting downloads
            await sleep(500);

            // Continue processing
            processNext();
        }

        if (completed >= totalTabs) {
            finishDownload();
        }
    };

    // Start initial batch
    processNext();
}

// Click download button on a tab
async function clickDownloadButton(tab) {
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // Find the download button
                const downloadBtn = document.querySelector('.btn-download');
                if (!downloadBtn) {
                    throw new Error('ダウンロードボタンが見つかりません');
                }

                // Click the button
                downloadBtn.click();
                return true;
            }
        }).then(results => {
            if (results && results[0] && results[0].result) {
                resolve(true);
            } else {
                reject(new Error('スクリプト実行に失敗'));
            }
        }).catch(error => {
            reject(error);
        });
    });
}

// Update progress bar
function updateProgress(current, total) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${current} / ${total} 完了`;
}

// Finish download process
function finishDownload() {
    isDownloading = false;
    startDownloadBtn.disabled = false;
    refreshTabsBtn.disabled = false;
    statusEl.textContent = 'ダウンロード完了';
    log('すべてのダウンロードが完了しました', 'success');
}

// Add log entry
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

// Sleep utility
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
