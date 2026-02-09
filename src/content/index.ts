(() => {
  const hostWindow = window as Window & {
    __mclectureOpenOverlay?: () => void;
  };

  if (typeof hostWindow.__mclectureOpenOverlay === 'function') {
    hostWindow.__mclectureOpenOverlay();
    return;
  }

  const ROOT_ID = 'mclecture-popup';
  const OVERLAY_ID = 'mclecture-drag-overlay';
  const TITLE_BAR_ID = 'mclecture-title-bar';
  const CLOSE_BUTTON_ID = 'mclecture-close-button';
  const MINIMIZE_BUTTON_ID = 'mclecture-minimize-button';
  const MINIMIZED_CLASS = 'mclecture-minimized';
  const BOUNDS_STORAGE_KEY = 'overlayBounds';
  const MESSAGE_SOURCE = 'mclecture';
  const MESSAGE_TYPE_DOWNLOAD_STATE = 'download-state';
  const OPEN_OVERLAY_MESSAGE_TYPE = 'mclecture-open-overlay';

  const TITLE_BAR_HEIGHT = 40;
  const DEFAULT_MARGIN = 24;
  const FIXED_WIDTH = 760;
  const FIXED_HEIGHT = 560;
  const MINIMIZED_SIZE = 62;

  interface OverlayBounds {
    left: number;
    top: number;
    width: number;
    height: number;
    minimized: boolean;
  }

  interface DownloadStateMessage {
    source?: string;
    type?: string;
    active?: boolean;
    channel?: string;
  }

  let hasActiveDownload = false;
  let activeFrame: HTMLIFrameElement | null = null;
  let activeChannel = '';
  let saveTimeout: number | null = null;

  const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
  const iconUrl = chrome.runtime.getURL('icons/icon.png');

  function clamp(value: number, min: number, max: number): number {
    if (max <= min) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  function createChannelId(): string {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getDefaultBounds(): OverlayBounds {
    const width = Math.max(Math.min(FIXED_WIDTH, window.innerWidth - DEFAULT_MARGIN * 2), 360);
    const height = Math.max(Math.min(FIXED_HEIGHT, window.innerHeight - DEFAULT_MARGIN * 2), 260);

    return {
      left: clamp(window.innerWidth - width - DEFAULT_MARGIN, 0, Math.max(window.innerWidth - width, 0)),
      top: clamp(DEFAULT_MARGIN, 0, Math.max(window.innerHeight - height, 0)),
      width,
      height,
      minimized: false
    };
  }

  function normalizeBounds(input: Partial<OverlayBounds>): OverlayBounds {
    const width = Math.max(Math.min(FIXED_WIDTH, window.innerWidth - DEFAULT_MARGIN * 2), 360);
    const height = Math.max(Math.min(FIXED_HEIGHT, window.innerHeight - DEFAULT_MARGIN * 2), 260);

    return {
      width,
      height,
      left: clamp(
        Number.isFinite(input.left) ? (input.left as number) : DEFAULT_MARGIN,
        0,
        Math.max(window.innerWidth - width, 0)
      ),
      top: clamp(
        Number.isFinite(input.top) ? (input.top as number) : DEFAULT_MARGIN,
        0,
        Math.max(window.innerHeight - height, 0)
      ),
      minimized: Boolean(input.minimized)
    };
  }

  function applyBounds(root: HTMLElement, bounds: OverlayBounds): void {
    root.style.left = `${bounds.left}px`;
    root.style.top = `${bounds.top}px`;
    root.style.width = `${bounds.width}px`;
    root.style.height = `${bounds.height}px`;
    root.style.right = 'auto';

    if (bounds.minimized) {
      root.classList.add(MINIMIZED_CLASS);
    } else {
      root.classList.remove(MINIMIZED_CLASS);
    }
  }

  async function storageGet<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result[key] as T | undefined);
      });
    });
  }

  async function storageSet<T>(key: string, value: T): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  async function saveBounds(root: HTMLElement): Promise<void> {
    const bounds: OverlayBounds = normalizeBounds({
      left: root.offsetLeft,
      top: root.offsetTop,
      width: root.offsetWidth,
      height: root.offsetHeight,
      minimized: root.classList.contains(MINIMIZED_CLASS)
    });

    try {
      await storageSet(BOUNDS_STORAGE_KEY, bounds);
    } catch {
      // Ignore storage write failures in content script.
    }
  }

  async function readBounds(): Promise<OverlayBounds> {
    try {
      const value = await storageGet<Partial<OverlayBounds>>(BOUNDS_STORAGE_KEY);
      return normalizeBounds(value ?? getDefaultBounds());
    } catch {
      return getDefaultBounds();
    }
  }

  function scheduleSaveBounds(root: HTMLElement): void {
    if (saveTimeout !== null) {
      window.clearTimeout(saveTimeout);
    }

    saveTimeout = window.setTimeout(() => {
      saveTimeout = null;
      void saveBounds(root);
    }, 160);
  }

  function ensureStyle(): void {
    let style = document.getElementById('mclecture-style') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'mclecture-style';
      document.head.append(style);
    }

    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        width: ${FIXED_WIDTH}px;
        height: ${FIXED_HEIGHT}px;
        border: 1px solid #1f2937;
        border-radius: 14px;
        background: #111827;
        box-shadow: 0 20px 60px rgba(2, 6, 23, 0.45);
        z-index: 2147483646;
        overflow: hidden;
        resize: none;
        animation: mclecture-pop-in 0.22s ease;
        transform-origin: top right;
      }

      #${ROOT_ID} iframe {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        height: calc(100% - ${TITLE_BAR_HEIGHT}px);
        border: none;
        background: #ffffff;
        transition: opacity 0.2s ease;
      }

      #${ROOT_ID}.${MINIMIZED_CLASS} {
        width: ${MINIMIZED_SIZE}px !important;
        height: ${MINIMIZED_SIZE}px !important;
        min-height: ${MINIMIZED_SIZE}px !important;
        resize: none;
        border-radius: 999px;
        background:
          url('${iconUrl}') center / 30px 30px no-repeat,
          radial-gradient(circle at 30% 30%, #c53f5b 0%, #9e1b32 60%, #7d1628 100%);
        border: 2px solid #7d1628;
        box-shadow: 0 14px 32px rgba(125, 22, 40, 0.42);
        cursor: pointer;
        overflow: hidden;
      }

      #${ROOT_ID}.${MINIMIZED_CLASS} iframe {
        opacity: 0 !important;
        pointer-events: none;
      }

      #${ROOT_ID}.${MINIMIZED_CLASS} #${TITLE_BAR_ID},
      #${ROOT_ID}.${MINIMIZED_CLASS} #${CLOSE_BUTTON_ID},
      #${ROOT_ID}.${MINIMIZED_CLASS} #${MINIMIZE_BUTTON_ID} {
        display: none !important;
      }

      #${TITLE_BAR_ID} {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: ${TITLE_BAR_HEIGHT}px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(90deg, #7d1628, #9e1b32);
        color: #f9fafb;
        font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        user-select: none;
        cursor: move;
      }

      #${CLOSE_BUTTON_ID},
      #${MINIMIZE_BUTTON_ID} {
        all: unset;
        position: absolute;
        top: 8px;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        text-align: center;
        color: #ffffff;
        cursor: pointer;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      #${CLOSE_BUTTON_ID}:focus-visible,
      #${MINIMIZE_BUTTON_ID}:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }

      #${CLOSE_BUTTON_ID} {
        right: 8px;
        background: #dc2626;
        font-size: 12px;
        font-weight: 700;
        line-height: 24px;
      }

      #${MINIMIZE_BUTTON_ID} {
        right: 36px;
        background: #4b5563;
        font-size: 14px;
        font-weight: 700;
        line-height: 24px;
      }

      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        cursor: move;
      }

      @keyframes mclecture-pop-in {
        from {
          opacity: 0;
          transform: translateY(-6px) scale(0.985);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
    `;

  }

  function createTitleBar(): HTMLDivElement {
    const titleBar = document.createElement('div');
    titleBar.id = TITLE_BAR_ID;
    titleBar.textContent = 'McLecture';
    return titleBar;
  }

  function detachPopup(userInitiated: boolean): boolean {
    if (userInitiated && hasActiveDownload) {
      const shouldClose = window.confirm(
        'Downloads are still in progress. Closing now may interrupt them. Close anyway?'
      );
      if (!shouldClose) {
        return false;
      }
    }

    document.getElementById(ROOT_ID)?.remove();
    activeFrame = null;

    if (saveTimeout !== null) {
      window.clearTimeout(saveTimeout);
      saveTimeout = null;
    }

    return true;
  }

  function createCloseButton(): HTMLButtonElement {
    const closeButton = document.createElement('button');
    closeButton.id = CLOSE_BUTTON_ID;
    closeButton.textContent = 'X';
    closeButton.title = 'Close';

    closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      detachPopup(true);
    });

    return closeButton;
  }

  function createMinimizeButton(root: HTMLElement): HTMLButtonElement {
    const minimizeButton = document.createElement('button');
    minimizeButton.id = MINIMIZE_BUTTON_ID;
    minimizeButton.textContent = '−';
    minimizeButton.title = 'Minimize';

    const sync = () => {
      const minimized = root.classList.contains(MINIMIZED_CLASS);
      minimizeButton.textContent = minimized ? '+' : '−';
      minimizeButton.title = minimized ? 'Restore' : 'Minimize';
      minimizeButton.setAttribute('aria-label', minimized ? 'Restore' : 'Minimize');
      scheduleSaveBounds(root);
    };

    minimizeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.classList.toggle(MINIMIZED_CLASS);
      sync();
    });

    sync();
    return minimizeButton;
  }

  function restoreFromMinimized(root: HTMLElement, minimizeButton: HTMLButtonElement): void {
    if (!root.classList.contains(MINIMIZED_CLASS)) {
      return;
    }

    root.classList.remove(MINIMIZED_CLASS);
    minimizeButton.textContent = '−';
    minimizeButton.title = 'Minimize';
    minimizeButton.setAttribute('aria-label', 'Minimize');
    scheduleSaveBounds(root);
  }

  function makeDraggable(
    element: HTMLElement,
    handle: HTMLElement,
    options?: { onlyWhenMinimized?: boolean; onDragEnd?: (moved: boolean) => void }
  ): void {
    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }

      if (options?.onlyWhenMinimized && !element.classList.contains(MINIMIZED_CLASS)) {
        return;
      }

      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = element.offsetLeft;
      const startTop = element.offsetTop;
      let moved = false;

      const dragOverlay = document.createElement('div');
      dragOverlay.id = OVERLAY_ID;
      document.body.append(dragOverlay);

      const onMouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();

        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (!moved && (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2)) {
          moved = true;
        }

        const nextLeft = clamp(startLeft + deltaX, 0, Math.max(window.innerWidth - element.offsetWidth, 0));
        const nextTop = clamp(startTop + deltaY, 0, Math.max(window.innerHeight - element.offsetHeight, 0));

        element.style.left = `${nextLeft}px`;
        element.style.top = `${nextTop}px`;
        element.style.right = 'auto';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        dragOverlay.remove();
        scheduleSaveBounds(element);
        options?.onDragEnd?.(moved);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function makeMinimizedClickableAndDraggable(element: HTMLElement, onClick: () => void): void {
    element.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || !element.classList.contains(MINIMIZED_CLASS)) {
        return;
      }

      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = element.offsetLeft;
      const startTop = element.offsetTop;
      let moved = false;

      const dragOverlay = document.createElement('div');
      dragOverlay.id = OVERLAY_ID;
      document.body.append(dragOverlay);

      const onMouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();

        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (!moved && (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2)) {
          moved = true;
        }

        if (!moved) {
          return;
        }

        const nextLeft = clamp(startLeft + deltaX, 0, Math.max(window.innerWidth - element.offsetWidth, 0));
        const nextTop = clamp(startTop + deltaY, 0, Math.max(window.innerHeight - element.offsetHeight, 0));

        element.style.left = `${nextLeft}px`;
        element.style.top = `${nextTop}px`;
        element.style.right = 'auto';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        dragOverlay.remove();

        if (moved) {
          scheduleSaveBounds(element);
          return;
        }

        onClick();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function focusExistingPopup(): boolean {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return false;
    }

    const minimizeButton = document.getElementById(MINIMIZE_BUTTON_ID) as HTMLButtonElement | null;
    if (root.classList.contains(MINIMIZED_CLASS) && minimizeButton) {
      restoreFromMinimized(root, minimizeButton);
    }

    root.style.zIndex = '2147483646';
    scheduleSaveBounds(root);
    return true;
  }

  async function attachPopup(): Promise<void> {
    ensureStyle();
    if (focusExistingPopup()) {
      return;
    }

    const root = document.createElement('div');
    root.id = ROOT_ID;

    const iframe = document.createElement('iframe');
    const channel = createChannelId();
    const popupUrl = new URL(chrome.runtime.getURL('popup.html'));
    popupUrl.searchParams.set('channel', channel);
    popupUrl.searchParams.set('parentOrigin', window.location.origin);
    iframe.src = popupUrl.toString();

    const titleBar = createTitleBar();
    const closeButton = createCloseButton();
    const minimizeButton = createMinimizeButton(root);

    root.append(iframe, closeButton, minimizeButton, titleBar);
    document.body.prepend(root);

    const storedBounds = await readBounds();
    applyBounds(root, storedBounds);

    activeFrame = iframe;
    activeChannel = channel;

    makeDraggable(root, titleBar);
    makeMinimizedClickableAndDraggable(root, () => restoreFromMinimized(root, minimizeButton));
    scheduleSaveBounds(root);
  }

  const onMessage = (event: MessageEvent) => {
    const data = event.data as DownloadStateMessage | undefined;
    if (!data || data.source !== MESSAGE_SOURCE || data.type !== MESSAGE_TYPE_DOWNLOAD_STATE) {
      return;
    }

    if (event.origin !== extensionOrigin) {
      return;
    }

    if (!activeFrame || event.source !== activeFrame.contentWindow) {
      return;
    }

    if (data.channel !== activeChannel) {
      return;
    }

    hasActiveDownload = Boolean(data.active);
  };

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasActiveDownload) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
  };

  const onWindowResize = () => {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      return;
    }

    const bounds = normalizeBounds({
      left: root.offsetLeft,
      top: root.offsetTop,
      width: root.offsetWidth,
      height: root.offsetHeight,
      minimized: root.classList.contains(MINIMIZED_CLASS)
    });

    applyBounds(root, bounds);
    scheduleSaveBounds(root);
  };

  const onRuntimeMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean => {
    const payload = message as { type?: string } | null;
    if (!payload || payload.type !== OPEN_OVERLAY_MESSAGE_TYPE) {
      return false;
    }

    void attachPopup().then(() => {
      sendResponse({ handled: true });
    });
    return true;
  };

  window.addEventListener('message', onMessage);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('resize', onWindowResize);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  hostWindow.__mclectureOpenOverlay = () => {
    void attachPopup();
  };

  void attachPopup();
})();
