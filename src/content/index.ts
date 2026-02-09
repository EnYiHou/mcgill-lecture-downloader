const ROOT_ID = 'mclecture-popup';
const OVERLAY_ID = 'mclecture-drag-overlay';
const TITLE_BAR_ID = 'mclecture-title-bar';
const CLOSE_BUTTON_ID = 'mclecture-close-button';

function ensureStyle(): void {
  if (document.getElementById('mclecture-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'mclecture-style';
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      top: 60px;
      right: 60px;
      width: 600px;
      height: 600px;
      min-width: 600px;
      border: 1px solid #1f2937;
      border-radius: 10px;
      background: #111827;
      z-index: 2147483646;
      overflow: hidden;
    }

    #${ROOT_ID} iframe {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      width: 100%;
      height: calc(100% - 36px);
      border: none;
      background: #ffffff;
    }

    #${TITLE_BAR_ID} {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111827;
      color: #f9fafb;
      font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      user-select: none;
      cursor: move;
    }

    #${CLOSE_BUTTON_ID} {
      all: unset;
      position: absolute;
      right: 8px;
      top: 6px;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      text-align: center;
      color: #ffffff;
      background: #dc2626;
      font: 700 12px/24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: pointer;
      z-index: 2147483647;
    }

    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      cursor: move;
    }
  `;

  document.head.append(style);
}

function createTitleBar(): HTMLDivElement {
  const titleBar = document.createElement('div');
  titleBar.id = TITLE_BAR_ID;
  titleBar.textContent = 'McGill Lectures Downloader';
  return titleBar;
}

function detachPopup(): void {
  document.getElementById(ROOT_ID)?.remove();
}

function createCloseButton(): HTMLButtonElement {
  const closeButton = document.createElement('button');
  closeButton.id = CLOSE_BUTTON_ID;
  closeButton.textContent = 'X';

  closeButton.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;

    const onMouseUp = (mouseupEvent: MouseEvent) => {
      const deltaX = Math.abs(mouseupEvent.clientX - startX);
      const deltaY = Math.abs(mouseupEvent.clientY - startY);

      if (deltaX < 5 && deltaY < 5) {
        detachPopup();
      }

      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mouseup', onMouseUp);
  });

  return closeButton;
}

function makeDraggable(element: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = element.offsetLeft;
    const startTop = element.offsetTop;

    const dragOverlay = document.createElement('div');
    dragOverlay.id = OVERLAY_ID;
    document.body.append(dragOverlay);

    const onMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      moveEvent.stopPropagation();

      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      element.style.left = `${startLeft + deltaX}px`;
      element.style.top = `${startTop + deltaY}px`;
      element.style.right = 'auto';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      dragOverlay.remove();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function attachPopup(): void {
  ensureStyle();
  detachPopup();

  const root = document.createElement('div');
  root.id = ROOT_ID;

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('popup.html');

  const titleBar = createTitleBar();
  const closeButton = createCloseButton();

  root.append(iframe, closeButton, titleBar);
  document.body.prepend(root);

  makeDraggable(root, titleBar);
}

attachPopup();
