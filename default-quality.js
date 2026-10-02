/* Applies the saved quality preference in YouTube's page world, where the
 * player API is available. The preference is an upper bound: choose the
 * highest quality YouTube currently offers at or below it. */
(() => {
  if (window.__ytProDefaultQualityInstalled) return;
  window.__ytProDefaultQualityInstalled = true;

  const choices = [
    [2160, 'hd2160'], [1440, 'hd1440'], [1080, 'hd1080'],
    [720, 'hd720'], [480, 'large'], [360, 'medium'], [240, 'small']
  ];
  let cap = 1080;
  let videoSource = '';
  let attempts = 0;
  let timer;

  function player() {
    return document.getElementById('movie_player') ||
      document.querySelector('ytd-player #movie_player');
  }

  function apply() {
    const p = player();
    if (!p || typeof p.getAvailableQualityLevels !== 'function') return false;
    const available = p.getAvailableQualityLevels() || [];
    const supported = choices.filter(([, token]) => available.includes(token));
    const target = supported.find(([height]) => height <= cap);
    if (!target) return false;
    const [, token] = target;
    try {
      if (typeof p.setPlaybackQualityRange === 'function') {
        p.setPlaybackQualityRange('small', token);
      }
      if (typeof p.getPlaybackQuality !== 'function' || p.getPlaybackQuality() !== token) {
        p.setPlaybackQuality(token);
      }
      return true;
    } catch (_) { return false; }
  }

  function beginApply() {
    attempts = 0;
    clearInterval(timer);
    timer = setInterval(() => {
      attempts++;
      if (apply() || attempts >= 15) clearInterval(timer);
    }, 700);
    apply();
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== 'yt-pro-plus-quality') return;
    const value = Number(event.data.quality);
    cap = [360, 480, 720, 1080, 1440, 2160].includes(value) ? value : 1080;
    beginApply();
  });

  document.addEventListener('yt-navigate-finish', beginApply);
  document.addEventListener('loadedmetadata', event => {
    if (event.target instanceof HTMLVideoElement) beginApply();
  }, true);

  setInterval(() => {
    const video = document.querySelector('video.html5-main-video');
    if (video && video.currentSrc && video.currentSrc !== videoSource) {
      videoSource = video.currentSrc;
      beginApply();
    }
  }, 1200);
})();
