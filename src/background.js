'use strict';

/**
 * 快捷键 Alt+Shift+D：把“当前网站规则”在“关闭 / 强制开启”之间切换。
 * 真正的站点识别和写入由内容脚本完成，这样不需要申请读取全部标签页网址的权限。
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-site') return;

  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'EDM_TOGGLE_SITE' });
  } catch {
    // edge:// 页面、扩展商店等受限页面没有内容脚本，忽略即可。
  }
});
