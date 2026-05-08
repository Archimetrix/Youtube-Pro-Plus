// ── YouTube Pro + · Report Page ───────────────────────────────────────────────
// Opened in a dedicated tab to avoid Firefox's popup-closes-on-file-dialog bug.
(function () {
    'use strict';

    const fileInput   = document.getElementById('file-input');
    const uploadArea  = document.getElementById('upload-area');
    const previewGrid = document.getElementById('preview-grid');
    const submitBtn   = document.getElementById('submit-btn');
    const statusEl    = document.getElementById('status');

    let imageFiles = [];

    // ── File selection ────────────────────────────────────────────────────────
    fileInput.addEventListener('change', () => {
        Array.from(fileInput.files).forEach(file => {
            if (imageFiles.length >= 3 || !file.type.startsWith('image/')) return;
            imageFiles.push(file);
        });
        fileInput.value = '';
        renderPreviews();
    });

    function renderPreviews() {
        previewGrid.innerHTML = '';
        imageFiles.forEach((file, idx) => {
            const url  = URL.createObjectURL(file);
            const item = document.createElement('div');
            item.className = 'preview-item';
            const img  = document.createElement('img');
            img.src    = url;
            img.onload = () => URL.revokeObjectURL(url);
            const rmBtn = document.createElement('button');
            rmBtn.className   = 'preview-remove';
            rmBtn.textContent = '×';
            rmBtn.addEventListener('click', () => {
                imageFiles.splice(idx, 1);
                renderPreviews();
            });
            item.appendChild(img);
            item.appendChild(rmBtn);
            previewGrid.appendChild(item);
        });
        uploadArea.style.display = imageFiles.length >= 3 ? 'none' : '';
    }

    // ── Submit ────────────────────────────────────────────────────────────────
    submitBtn.addEventListener('click', async () => {
        const name    = (document.getElementById('rep-name').value    || '').trim();
        const message = (document.getElementById('rep-message').value || '').trim();

        if (!message) {
            setStatus('error', '⚠️ Please describe the issue before sending.');
            return;
        }

        submitBtn.disabled = true;
        setStatus('', '📤 Sending…');

        try {
            const uploadToCatbox = async (file) => {
                const fd = new FormData();
                fd.append('reqtype',      'fileupload');
                fd.append('fileToUpload', file, file.name || 'screenshot.jpg');
                const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
                if (!r.ok) throw new Error('catbox upload failed: ' + r.status);
                const url = (await r.text()).trim();
                if (!url.startsWith('https://')) throw new Error('Bad catbox response: ' + url);
                return url;
            };

            let screenshotHtml = '';
            if (imageFiles.length > 0) {
                const urls = await Promise.all(imageFiles.map(uploadToCatbox));
                const imgTags = urls.map((url, i) =>
                    `<div style="margin:8px 0;"><strong>Screenshot ${i + 1}</strong><br>` +
                    `<a href="${url}"><img src="${url}" alt="Screenshot ${i + 1}" ` +
                    `style="max-width:600px;display:block;border:1px solid #ccc;border-radius:4px;margin-top:4px;"></a></div>`
                ).join('');
                screenshotHtml = `<br><br><hr style="border:none;border-top:1px solid #ccc;margin:12px 0;">` +
                    `<strong>Screenshots (${urls.length})</strong><br><br>${imgTags}`;
            }

            const formData = new FormData();
            formData.append('Name',    name || 'Anonymous');
            formData.append('Message', message + screenshotHtml);
            formData.append('Browser', navigator.userAgent);

            const res = await fetch('https://formbold.com/s/3A7PM', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Server returned ' + res.status);

            setStatus('success', '✅ Report sent! We will look into it soon. Thank you!');
            document.getElementById('rep-name').value    = '';
            document.getElementById('rep-message').value = '';
            imageFiles = [];
            renderPreviews();

        } catch (err) {
            setStatus('error', '❌ Failed to send. Check your internet and try again.');
            console.error('[Report] Error:', err);
        }

        submitBtn.disabled = false;
    });

    function setStatus(cls, text) {
        statusEl.className   = cls;
        statusEl.textContent = text;
    }
})();
