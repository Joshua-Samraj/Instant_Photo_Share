/* SnapSync shared client helpers. No framework, no build step. */
(function () {
    'use strict';

    async function api(path, options = {}) {
        const opts = { credentials: 'same-origin', ...options };
        const isForm = opts.body instanceof FormData;
        opts.headers = { ...(opts.headers || {}) };
        if (!isForm && opts.body && typeof opts.body !== 'string') {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }

        const response = await fetch(path, opts);
        const text = await response.text();
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (error) {
                throw new Error(`Unexpected response from the server (${response.status}).`);
            }
        }

        if (!response.ok) {
            const error = new Error((data && (data.error || data.message)) || `Request failed (${response.status}).`);
            error.status = response.status;
            error.code = data && data.code;
            error.data = data;
            throw error;
        }
        return data || {};
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function formatDate(value, options = {}) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            ...options
        }).format(date);
    }

    function formatDateTime(value) {
        return formatDate(value, { hour: 'numeric', minute: '2-digit' });
    }

    function initials(name) {
        return String(name || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0].toUpperCase())
            .join('');
    }

    function toast(message, type = 'info', timeout = 4200) {
        let host = document.getElementById('toast-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toast-host';
            host.style.cssText = 'position:fixed;z-index:100;bottom:20px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:10px;width:min(420px,calc(100vw - 32px));pointer-events:none;';
            document.body.appendChild(host);
        }

        const palette = {
            success: { bg: '#1f3d2b', border: '#2f5c40', fg: '#f3fbf5' },
            error: { bg: '#4a1f1f', border: '#7a3030', fg: '#fff2f2' },
            info: { bg: '#1a1817', border: '#3d3833', fg: '#fbf9f5' }
        }[type] || { bg: '#1a1817', border: '#3d3833', fg: '#fbf9f5' };

        const node = document.createElement('div');
        node.setAttribute('role', type === 'error' ? 'alert' : 'status');
        node.style.cssText = `pointer-events:auto;background:${palette.bg};border:1px solid ${palette.border};color:${palette.fg};padding:12px 16px;font:500 13px/1.45 Montserrat,system-ui,sans-serif;letter-spacing:.01em;box-shadow:0 12px 30px rgba(0,0,0,.22);border-radius:2px;opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;`;
        node.textContent = message;
        host.appendChild(node);

        requestAnimationFrame(() => {
            node.style.opacity = '1';
            node.style.transform = 'translateY(0)';
        });

        const remove = () => {
            node.style.opacity = '0';
            node.style.transform = 'translateY(8px)';
            setTimeout(() => node.remove(), 200);
        };
        setTimeout(remove, timeout);
        node.addEventListener('click', remove);
        return node;
    }

    function confirmAction({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(26,24,23,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;';
            overlay.innerHTML = `
                <div role="dialog" aria-modal="true" style="background:#fff;border:1px solid #ebe6de;max-width:420px;width:100%;padding:28px;box-shadow:0 30px 70px rgba(0,0,0,.25);">
                    <h2 style="font:400 26px/1.15 'Cormorant Garamond',Georgia,serif;color:#1a1817;margin:0 0 8px;">${escapeHtml(title)}</h2>
                    <p style="font:400 13px/1.6 Montserrat,system-ui,sans-serif;color:#78736a;margin:0 0 24px;white-space:pre-line;">${escapeHtml(message)}</p>
                    <div style="display:flex;gap:10px;justify-content:flex-end;">
                        <button type="button" data-cancel style="padding:11px 18px;background:#fff;border:1px solid #ebe6de;color:#1a1817;font:500 11px/1 Montserrat,sans-serif;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;">Cancel</button>
                        <button type="button" data-confirm style="padding:11px 18px;background:${danger ? '#7a3030' : '#1a1817'};border:1px solid ${danger ? '#7a3030' : '#1a1817'};color:#fbf9f5;font:500 11px/1 Montserrat,sans-serif;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;">${escapeHtml(confirmLabel)}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const finish = (result) => {
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(result);
            };
            const onKey = (event) => {
                if (event.key === 'Escape') finish(false);
            };

            overlay.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
            overlay.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) finish(false);
            });
            document.addEventListener('keydown', onKey);
            overlay.querySelector('[data-confirm]').focus();
        });
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            area.remove();
            return ok;
        }
    }

    function loadImageElement(file) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => {
                URL.revokeObjectURL(url);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
            image.src = url;
        });
    }

    /**
     * Resize + re-encode images in the browser. This keeps every upload under
     * Vercel's 4.5 MB serverless request limit.
     */
    async function compressImage(file, { maxDimension = 2200, quality = 0.86, maxBytes = 3.4 * 1024 * 1024 } = {}) {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            throw new Error('Only image files are supported.');
        }
        if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

        let bitmap = null;
        try {
            bitmap = await createImageBitmap(file);
        } catch (error) {
            // Some Safari versions lack createImageBitmap; fall back to an <img>.
            bitmap = await loadImageElement(file);
            if (!bitmap) return file;
        }

        const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        if (bitmap.close) bitmap.close();

        let currentQuality = quality;
        let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', currentQuality));
        while (blob && blob.size > maxBytes && currentQuality > 0.5) {
            currentQuality -= 0.08;
            blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', currentQuality));
        }
        if (!blob) return file;

        const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
        return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
    }

    function downloadLink(url, filename) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename || '';
        anchor.rel = 'noopener';
        anchor.target = '_blank';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    function debounce(fn, wait = 250) {
        let timer;
        return function debounced(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    window.SnapUI = {
        api,
        escapeHtml,
        formatDate,
        formatDateTime,
        initials,
        toast,
        confirmAction,
        copyText,
        compressImage,
        downloadLink,
        debounce
    };
})();
