// YouTube Pro+ — report.js
// Runs as a normal extension tab (not the popup), so the browser's native
// file picker for screenshot attachments never causes the UI to close.

document.addEventListener('DOMContentLoaded', () => {
  const reportFileInput = document.getElementById('report-file-input');
  const reportPreview    = document.getElementById('report-preview-grid');
  const reportSubmitBtn  = document.getElementById('report-submit-btn');
  const reportStatus     = document.getElementById('report-status');
  const reportNameInput  = document.getElementById('report-name');
  const reportMessageBox = document.getElementById('report-message');
  const uploadArea        = document.getElementById('report-upload-area');

  let reportImageFiles = [];

  reportFileInput.addEventListener('change', () => {
    Array.from(reportFileInput.files).forEach((file) => {
      if (reportImageFiles.length >= 3 || !file.type.startsWith('image/')) return;
      reportImageFiles.push(file);
    });
    reportFileInput.value = '';
    renderReportPreviews();
  });

  function renderReportPreviews() {
    reportPreview.innerHTML = '';
    reportImageFiles.forEach((file, idx) => {
      const url = URL.createObjectURL(file);
      const item = document.createElement('div');
      item.className = 'report-preview-item';
      const img = document.createElement('img');
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      const rmBtn = document.createElement('button');
      rmBtn.className = 'report-preview-remove';
      rmBtn.textContent = '×';
      rmBtn.addEventListener('click', () => {
        reportImageFiles.splice(idx, 1);
        renderReportPreviews();
      });
      item.appendChild(img);
      item.appendChild(rmBtn);
      reportPreview.appendChild(item);
    });
    if (uploadArea) uploadArea.style.display = reportImageFiles.length >= 3 ? 'none' : '';
  }

  reportSubmitBtn.addEventListener('click', async () => {
    const name = (reportNameInput.value || '').trim();
    const message = (reportMessageBox.value || '').trim();

    if (!message) {
      reportStatus.className = 'error';
      reportStatus.textContent = '⚠️ Please describe the issue before sending.';
      return;
    }

    reportSubmitBtn.disabled = true;
    reportStatus.className = '';
    reportStatus.textContent = '📤 Sending…';

    try {
      // Upload each screenshot to catbox.moe (free, anonymous, permanent hosting).
      // Gmail blocks data: URLs but renders normal https:// image links fine.
      const uploadToCatbox = async (file) => {
        const fd = new FormData();
        fd.append('reqtype', 'fileupload');
        fd.append('fileToUpload', file, file.name || 'screenshot.jpg');
        const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
        if (!r.ok) throw new Error('catbox upload failed: ' + r.status);
        const url = (await r.text()).trim();
        if (!url.startsWith('https://')) throw new Error('Bad catbox response: ' + url);
        return url;
      };

      let screenshotHtml = '';
      if (reportImageFiles.length > 0) {
        const urls = await Promise.all(reportImageFiles.map(uploadToCatbox));
        const imgTags = urls
          .map(
            (url, i) =>
              `<div style="margin:8px 0;"><strong>Screenshot ${i + 1}</strong><br><a href="${url}"><img src="${url}" alt="Screenshot ${i + 1}" style="max-width:600px;display:block;border:1px solid #ccc;border-radius:4px;margin-top:4px;"></a></div>`
          )
          .join('');
        screenshotHtml = `<br><br><hr style="border:none;border-top:1px solid #ccc;margin:12px 0;"><strong>Screenshots (${urls.length})</strong><br><br>${imgTags}`;
      }

      const formData = new FormData();
      formData.append('Name', name || 'Anonymous');
      formData.append('Message', message + screenshotHtml);
      formData.append('Browser', navigator.userAgent);

      const res = await fetch('https://formbold.com/s/3A7PM', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        reportStatus.className = 'success';
        reportStatus.textContent = '✅ Report sent! We will look into it soon. Thank you!';
        reportNameInput.value = '';
        reportMessageBox.value = '';
        reportImageFiles = [];
        renderReportPreviews();
      } else {
        throw new Error('Server returned ' + res.status);
      }
    } catch (err) {
      reportStatus.className = 'error';
      reportStatus.textContent = '❌ Failed to send. Check your internet and try again.';
      console.error('[Report] Error:', err);
    }

    reportSubmitBtn.disabled = false;
  });
});
