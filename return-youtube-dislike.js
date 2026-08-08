// ─── Return YouTube Dislike ─────────────────────────────────────────────────
// Adapted from the "Return YouTube Dislike" userscript (v3.1.5) by Anarios & JRWR
// https://www.returnyoutubedislike.com/  — MIT licensed, ported into the
// extension's own toggle system so it can be switched on/off from the panel
// just like the other features (no Tampermonkey / GM_* APIs required, since
// this file already runs as a normal isolated-world content script).
//
// Exposes a small controller on window._ytProReturnDislike with init()/teardown()
// so content.js can turn the feature on or off without a full page reload.

(function () {
    if (window._ytProReturnDislike) return; // already installed

    // Never run on YouTube Music — same exclusion as the original userscript.
    if (location.hostname === 'music.youtube.com') return;

    const extConfig = {
        disableLogging: true,
        coloredThumbs: false,
        coloredBar: false,
        colorTheme: 'classic',           // classic | accessible | neon
        numberDisplayFormat: 'compactShort',
        numberDisplayRoundDown: true,
        tooltipPercentageMode: 'none',
        numberDisplayReformatLikes: false,
        rateBarEnabled: false,
    };

    const LIKED_STATE = 'LIKED_STATE';
    const DISLIKED_STATE = 'DISLIKED_STATE';
    const NEUTRAL_STATE = 'NEUTRAL_STATE';

    let active = false;
    let previousState = 3; // 1=LIKED, 2=DISLIKED, 3=NEUTRAL
    let likesvalue = 0;
    let dislikesvalue = 0;
    let preNavigateLikeButton = null;
    let jsInitChecktimer = null;
    let smartimationObserver = null;
    let shortsObserver = null;
    let mobileInterval = null;
    let styleNode = null;
    let boundLikeButton = null;
    let boundDislikeButton = null;

    const isMobile = location.hostname === 'm.youtube.com';
    const isShorts = () => location.pathname.startsWith('/shorts');
    let mobileDislikes = 0;

    function cLog(text, subtext = '') {
        if (!extConfig.disableLogging) {
            subtext = subtext.trim() === '' ? '' : `(${subtext})`;
            console.log(`[Return YouTube Dislike] ${text} ${subtext}`);
        }
    }

    function isInViewport(element) {
        const rect = element.getBoundingClientRect();
        const height = innerHeight || document.documentElement.clientHeight;
        const width = innerWidth || document.documentElement.clientWidth;
        return (
            !(rect.top === 0 && rect.left === 0 && rect.bottom === 0 && rect.right === 0) &&
            rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width
        );
    }

    function getButtons() {
        if (isShorts()) {
            const elements = document.querySelectorAll(
                isMobile ? 'ytm-like-button-renderer' : '#like-button > ytd-like-button-renderer'
            );
            for (const element of elements) {
                if (isInViewport(element)) return element;
            }
        }
        if (isMobile) {
            return (
                document.querySelector('.slim-video-action-bar-actions .segmented-buttons') ??
                document.querySelector('.slim-video-action-bar-actions')
            );
        }
        if (document.getElementById('menu-container')?.offsetParent === null) {
            return (
                document.querySelector('ytd-menu-renderer.ytd-watch-metadata > div') ??
                document.querySelector('ytd-menu-renderer.ytd-video-primary-info-renderer > div')
            );
        }
        return document.getElementById('menu-container')?.querySelector('#top-level-buttons-computed');
    }

    function getDislikeButton() {
        const buttons = getButtons();
        if (!buttons || !buttons.children[0]) return null;
        if (buttons.children[0].tagName === 'YTD-SEGMENTED-LIKE-DISLIKE-BUTTON-RENDERER') {
            if (buttons.children[0].children[1] === undefined) {
                return document.querySelector('#segmented-dislike-button');
            }
            return buttons.children[0].children[1];
        }
        if (buttons.querySelector('segmented-like-dislike-button-view-model')) {
            const dislikeViewModel = buttons.querySelector('dislike-button-view-model');
            if (!dislikeViewModel) cLog("Dislike button wasn't added to DOM yet...");
            return dislikeViewModel;
        }
        return buttons.children[1];
    }

    function getLikeButton() {
        const buttons = getButtons();
        if (!buttons || !buttons.children[0]) return null;
        return buttons.children[0].tagName === 'YTD-SEGMENTED-LIKE-DISLIKE-BUTTON-RENDERER'
            ? document.querySelector('#segmented-like-button') ?? buttons.children[0].children[0]
            : buttons.querySelector('like-button-view-model') ?? buttons.children[0];
    }

    function getLikeTextContainer() {
        const likeButton = getLikeButton();
        return (
            likeButton?.querySelector('#text') ??
            likeButton?.getElementsByTagName('yt-formatted-string')[0] ??
            likeButton?.querySelector("span[role='text']")
        );
    }

    function getDislikeTextContainer() {
        const dislikeButton = getDislikeButton();
        if (!dislikeButton) return null;

        // Current YouTube markup (2025+):
        // dislike-button-view-model > toggle-button-view-model > button-view-model > button > div.yt-spec-button-shape-next__button-text-content
        let textContentDiv = dislikeButton.querySelector('.yt-spec-button-shape-next__button-text-content');
        if (textContentDiv) {
            // The div may itself hold a nested span, or just be a plain text node holder.
            return textContentDiv.querySelector('span') ?? textContentDiv;
        }

        let result =
            dislikeButton.querySelector('#text') ??
            dislikeButton.getElementsByTagName('yt-formatted-string')[0] ??
            dislikeButton.querySelector("span[role='text']");

        if (result == null) {
            const btn = dislikeButton.querySelector('button');
            if (!btn) return null;

            // Build the same wrapper YouTube uses for the like button's text so it
            // picks up the existing spacing/typography styles instead of looking bolted-on.
            textContentDiv = document.createElement('div');
            textContentDiv.className = 'yt-spec-button-shape-next__button-text-content';
            const textSpan = document.createElement('span');
            textSpan.id = 'text';
            textSpan.className = 'yt-core-attributed-string yt-core-attributed-string--white-space-no-wrap';
            textContentDiv.appendChild(textSpan);
            btn.appendChild(textContentDiv);
            btn.style.width = 'auto';
            result = textSpan;
        }
        return result;
    }

    function createObserver(options, callback) {
        const wrapper = {};
        wrapper.options = options;
        wrapper.observer = new MutationObserver(callback);
        wrapper.observe = function (element) { this.observer.observe(element, this.options); };
        wrapper.disconnect = function () { this.observer.disconnect(); };
        return wrapper;
    }

    function isVideoLiked() {
        if (isMobile) return getLikeButton()?.querySelector('button')?.getAttribute('aria-label') == 'true';
        return getLikeButton()?.classList.contains('style-default-active');
    }
    function isVideoDisliked() {
        if (isMobile) return getDislikeButton()?.querySelector('button')?.getAttribute('aria-label') == 'true';
        return getDislikeButton()?.classList.contains('style-default-active');
    }

    function checkForUserAvatarButton() {
        if (isMobile) return true;
        return !!document.querySelector('#avatar-btn');
    }

    function setLikes(likesCount) {
        if (isMobile) {
            const el = getButtons()?.children[0]?.querySelector('.button-renderer-text');
            if (el) el.innerText = likesCount;
            return;
        }
        const c = getLikeTextContainer();
        if (c) c.innerText = likesCount;
    }

    function setDislikes(dislikesCount) {
        if (isMobile) { mobileDislikes = dislikesCount; return; }
        const _container = getDislikeTextContainer();
        _container?.removeAttribute('is-empty');
        if (_container && _container.innerText !== dislikesCount) {
            _container.innerText = dislikesCount;
        }
    }

    function getLikeCountFromButton() {
        try {
            if (isShorts()) return false;
            const likeButton = getLikeButton();
            const el = likeButton?.querySelector('yt-formatted-string#text') ?? likeButton?.querySelector('button');
            const likesStr = el?.getAttribute('aria-label')?.replace(/\D/g, '') ?? '';
            return likesStr.length > 0 ? parseInt(likesStr) : false;
        } catch {
            return false;
        }
    }

    function injectStyles() {
        if (styleNode) return;
        styleNode = document.createElement('style');
        styleNode.id = 'yt-pro-ryd-style';
        styleNode.textContent = `
            #return-youtube-dislike-bar-container { background: var(--yt-spec-icon-disabled); border-radius: 2px; }
            #return-youtube-dislike-bar { background: var(--yt-spec-text-primary); border-radius: 2px; transition: all 0.15s ease-in-out; }
            .ryd-tooltip { position: absolute; display: block; height: 2px; bottom: -10px; }
            .ryd-tooltip-bar-container { width: 100%; height: 2px; position: absolute; padding-top: 6px; padding-bottom: 12px; top: -6px; }
            ytd-menu-renderer.ytd-watch-metadata { overflow-y: visible !important; }
            #top-level-buttons-computed { position: relative !important; }
        `;
        document.head.appendChild(styleNode);
    }

    function roundDown(num) {
        if (num < 1000) return num;
        const int = Math.floor(Math.log10(num) - 2);
        const decimal = int + (int % 3 ? 1 : 0);
        return Math.floor(num / 10 ** decimal) * 10 ** decimal;
    }

    function numberFormat(numberState) {
        const numberDisplay = extConfig.numberDisplayRoundDown === false ? numberState : roundDown(numberState);
        return getNumberFormatter(extConfig.numberDisplayFormat).format(numberDisplay);
    }

    function getNumberFormatter(optionSelect) {
        let userLocales = document.documentElement.lang || navigator.language || 'en';
        let formatterNotation, formatterCompactDisplay;
        switch (optionSelect) {
            case 'compactLong': formatterNotation = 'compact'; formatterCompactDisplay = 'long'; break;
            case 'standard': formatterNotation = 'standard'; formatterCompactDisplay = 'short'; break;
            default: formatterNotation = 'compact'; formatterCompactDisplay = 'short';
        }
        return Intl.NumberFormat(userLocales, { notation: formatterNotation, compactDisplay: formatterCompactDisplay });
    }

    function getColorFromTheme(voteIsLike) {
        switch (extConfig.colorTheme) {
            case 'accessible': return voteIsLike ? 'dodgerblue' : 'gold';
            case 'neon': return voteIsLike ? 'aqua' : 'magenta';
            default: return voteIsLike ? 'lime' : 'red';
        }
    }

    function createRateBar(likes, dislikes) {
        if (isMobile || !extConfig.rateBarEnabled) return;
        const buttons = getButtons();
        const likeBtn = getLikeButton();
        const dislikeBtn = getDislikeButton();
        if (!buttons || !likeBtn) return;

        let rateBar = document.getElementById('return-youtube-dislike-bar-container');
        const widthPx = likeBtn.clientWidth + (dislikeBtn?.clientWidth ?? 52);
        const widthPercent = likes + dislikes > 0 ? (likes / (likes + dislikes)) * 100 : 50;
        let likePercentage = parseFloat(widthPercent.toFixed(1));
        const dislikePercentage = (100 - likePercentage).toLocaleString();
        likePercentage = likePercentage.toLocaleString();

        let tooltipInnerHTML;
        switch (extConfig.tooltipPercentageMode) {
            case 'dash_like': tooltipInnerHTML = `${likes.toLocaleString()}&nbsp;/&nbsp;${dislikes.toLocaleString()}&nbsp;&nbsp;-&nbsp;&nbsp;${likePercentage}%`; break;
            case 'dash_dislike': tooltipInnerHTML = `${likes.toLocaleString()}&nbsp;/&nbsp;${dislikes.toLocaleString()}&nbsp;&nbsp;-&nbsp;&nbsp;${dislikePercentage}%`; break;
            case 'both': tooltipInnerHTML = `${likePercentage}%&nbsp;/&nbsp;${dislikePercentage}%`; break;
            case 'only_like': tooltipInnerHTML = `${likePercentage}%`; break;
            case 'only_dislike': tooltipInnerHTML = `${dislikePercentage}%`; break;
            default: tooltipInnerHTML = `${likes.toLocaleString()}&nbsp;/&nbsp;${dislikes.toLocaleString()}`;
        }

        if (!rateBar) {
            let colorDislikeStyle = '';
            if (extConfig.coloredBar) colorDislikeStyle = '; background-color: ' + getColorFromTheme(false);
            buttons.insertAdjacentHTML('beforeend', `
                <div class="ryd-tooltip" style="width: ${widthPx}px">
                <div class="ryd-tooltip-bar-container">
                   <div id="return-youtube-dislike-bar-container" style="width: 100%; height: 2px;${colorDislikeStyle}">
                      <div id="return-youtube-dislike-bar" style="width: ${widthPercent}%; height: 100%${colorDislikeStyle}"></div>
                   </div>
                </div>
                <tp-yt-paper-tooltip position="top" id="ryd-dislike-tooltip" class="style-scope ytd-sentiment-bar-renderer" role="tooltip" tabindex="-1">
                   <!--css-build:shady-->${tooltipInnerHTML}
                </tp-yt-paper-tooltip>
                </div>
            `);
            const descriptionAndActionsElement = document.getElementById('top-row');
            if (descriptionAndActionsElement) {
                descriptionAndActionsElement.style.borderBottom = '1px solid var(--yt-spec-10-percent-layer)';
                descriptionAndActionsElement.style.paddingBottom = '10px';
            }
        } else {
            const tip = document.querySelector('.ryd-tooltip');
            if (tip) tip.style.width = widthPx + 'px';
            const bar = document.getElementById('return-youtube-dislike-bar');
            if (bar) bar.style.width = widthPercent + '%';
            if (extConfig.coloredBar) {
                const barContainer = document.getElementById('return-youtube-dislike-bar-container');
                if (barContainer) barContainer.style.backgroundColor = getColorFromTheme(false);
                if (bar) bar.style.backgroundColor = getColorFromTheme(true);
            }
        }
    }

    function getVideoId() {
        const urlObject = new URL(window.location.href);
        const pathname = urlObject.pathname;
        if (pathname.startsWith('/clip')) {
            return (document.querySelector("meta[itemprop='videoId']") || document.querySelector("meta[itemprop='identifier']"))?.content;
        }
        if (pathname.startsWith('/shorts')) return pathname.slice(8);
        return urlObject.searchParams.get('v');
    }

    function isVideoLoaded() {
        if (isMobile) return document.getElementById('player')?.getAttribute('loading') == 'false';
        const videoId = getVideoId();
        return (
            document.querySelector(`ytd-watch-grid[video-id='${videoId}']`) !== null ||
            document.querySelector(`ytd-watch-flexy[video-id='${videoId}']`) !== null ||
            document.querySelector('#player[loading="false"]:not([hidden])') !== null
        );
    }

    function setState() {
        if (!active) return;
        cLog('Fetching votes...');
        let statsSet = false;
        const videoId = getVideoId();
        if (!videoId) return;

        fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${videoId}`)
            .then((response) => response.json())
            .then((json) => {
                if (!active) return;
                if (json && !statsSet) {
                    const { dislikes, likes } = json;
                    if (typeof dislikes !== 'number' || typeof likes !== 'number') return;
                    cLog(`Received count: ${dislikes}`);
                    statsSet = true;
                    likesvalue = likes;
                    dislikesvalue = dislikes;
                    setDislikes(numberFormat(dislikes));
                    if (extConfig.numberDisplayReformatLikes === true) {
                        const nativeLikes = getLikeCountFromButton();
                        if (nativeLikes !== false) setLikes(numberFormat(nativeLikes));
                    }
                    createRateBar(likes, dislikes);
                    if (extConfig.coloredThumbs === true) {
                        const dislikeButton = getDislikeButton();
                        const likeButton = getLikeButton();
                        if (likeButton) likeButton.style.color = getColorFromTheme(true);
                        if (dislikeButton) dislikeButton.style.color = getColorFromTheme(false);
                    }
                }
            })
            .catch(() => cLog('Failed to fetch vote counts'));
    }

    function updateDOMDislikes() {
        setDislikes(numberFormat(dislikesvalue));
        createRateBar(likesvalue, dislikesvalue);
    }

    function likeClicked() {
        if (!checkForUserAvatarButton()) return;
        if (previousState == 1) { likesvalue--; previousState = 3; }
        else if (previousState == 2) { likesvalue++; dislikesvalue--; previousState = 1; }
        else if (previousState == 3) { likesvalue++; previousState = 1; }
        updateDOMDislikes();
        if (extConfig.numberDisplayReformatLikes === true) {
            const nativeLikes = getLikeCountFromButton();
            if (nativeLikes !== false) setLikes(numberFormat(nativeLikes));
        }
    }

    function dislikeClicked() {
        if (!checkForUserAvatarButton()) return;
        if (previousState == 3) { dislikesvalue++; previousState = 2; }
        else if (previousState == 2) { dislikesvalue--; previousState = 3; }
        else if (previousState == 1) {
            likesvalue--; dislikesvalue++; previousState = 2;
            if (extConfig.numberDisplayReformatLikes === true) {
                const nativeLikes = getLikeCountFromButton();
                if (nativeLikes !== false) setLikes(numberFormat(nativeLikes));
            }
        }
        updateDOMDislikes();
    }

    function unbindButtons() {
        boundLikeButton?.removeEventListener('click', likeClicked);
        boundLikeButton?.removeEventListener('touchstart', likeClicked);
        boundDislikeButton?.removeEventListener('click', dislikeClicked);
        boundDislikeButton?.removeEventListener('touchstart', dislikeClicked);
        boundDislikeButton?.removeEventListener('focusin', updateDOMDislikes);
        boundDislikeButton?.removeEventListener('focusout', updateDOMDislikes);
        boundLikeButton = null;
        boundDislikeButton = null;
    }

    function checkForJSFinish() {
        if (!active) return;
        if (isShorts() || (getButtons()?.offsetParent && isVideoLoaded())) {
            const buttons = getButtons();
            const dislikeButton = getDislikeButton();
            const likeButton = getLikeButton();

            if (preNavigateLikeButton !== likeButton && dislikeButton && likeButton) {
                cLog('Registering button listeners...');
                try {
                    unbindButtons();
                    likeButton.addEventListener('click', likeClicked);
                    likeButton.addEventListener('touchstart', likeClicked);
                    dislikeButton.addEventListener('click', dislikeClicked);
                    dislikeButton.addEventListener('touchstart', dislikeClicked);
                    dislikeButton.addEventListener('focusin', updateDOMDislikes);
                    dislikeButton.addEventListener('focusout', updateDOMDislikes);
                    boundLikeButton = likeButton;
                    boundDislikeButton = dislikeButton;
                    preNavigateLikeButton = likeButton;

                    if (!smartimationObserver) {
                        smartimationObserver = createObserver({ attributes: true, subtree: true, childList: true }, updateDOMDislikes);
                        smartimationObserver.container = null;
                    }
                    const smartimationContainer = buttons?.querySelector('yt-smartimation');
                    if (smartimationContainer && smartimationObserver.container != smartimationContainer) {
                        smartimationObserver.disconnect();
                        smartimationObserver.observe(smartimationContainer);
                        smartimationObserver.container = smartimationContainer;
                    }
                } catch {
                    return;
                }
            }
            if (dislikeButton) {
                setState();
                clearInterval(jsInitChecktimer);
                jsInitChecktimer = null;
            }
        }
    }

    function setEventListeners() {
        if (!active) return;
        if (jsInitChecktimer) clearInterval(jsInitChecktimer);
        cLog('Setting up...');
        jsInitChecktimer = setInterval(checkForJSFinish, 111);
    }

    function onNavigate() {
        preNavigateLikeButton = null;
        setEventListeners();
    }

    // ── Self-init ────────────────────────────────────────────────────────────
    // Don't rely on content.js (a separate, differently-timed content script)
    // to kick this off — on a fresh page load it can run before this file has
    // even attached to window, silently doing nothing. Reading our own setting
    // here means this feature always turns on correctly on first load, not
    // just after the panel toggle is flipped off/on.
    function selfInit() {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
        try {
            chrome.storage.local.get(['masterEnabled', 'returnDislike'], (result) => {
                if (chrome.runtime?.lastError) return;
                if (result.masterEnabled === false) return;
                if (result.returnDislike !== false) window._ytProReturnDislike.init();
            });
        } catch {
            // extension context invalidated (e.g. mid-reload) — ignore
        }
    }

    // ── Public controller ───────────────────────────────────────────────────
    window._ytProReturnDislike = {
        init() {
            if (active) return;
            active = true;
            injectStyles();
            window.addEventListener('yt-navigate-finish', onNavigate, true);
            setEventListeners();
        },
        teardown() {
            active = false;
            if (jsInitChecktimer) { clearInterval(jsInitChecktimer); jsInitChecktimer = null; }
            if (mobileInterval) { clearInterval(mobileInterval); mobileInterval = null; }
            window.removeEventListener('yt-navigate-finish', onNavigate, true);
            unbindButtons();
            smartimationObserver?.disconnect();
            shortsObserver?.disconnect();
            document.querySelector('.ryd-tooltip')?.remove();
            document.getElementById('yt-pro-ryd-style')?.remove();
            styleNode = null;
            preNavigateLikeButton = null;
            likesvalue = 0;
            dislikesvalue = 0;
            previousState = 3;
        },
    };

    selfInit();
})();
