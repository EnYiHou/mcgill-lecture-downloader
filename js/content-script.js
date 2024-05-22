
function createPopup() {
  let popup = document.createElement("div");
  popup.setAttribute("id", "popup");

  let iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("popup.html");
  popup.appendChild(iframe);
  return popup;
}

function createTitleBar() {
  let titleBar = document.createElement("div");
  titleBar.setAttribute("id", "titleBar");
  titleBar.innerText = "McGill Lectures Downloader";
  return titleBar;
}

function createCloseButton() {
  let closeButton = document.createElement("button");
  closeButton.setAttribute("id", "closeButton");
  closeButton.innerText = "X";

  closeButton.addEventListener("mousedown", function (e) {
    e.preventDefault();
    closeButton.style.backgroundColor = "darkred";
    console.log("Close button clicked");
    let originalX = e.clientX;
    let originalY = e.clientY;
    let onMouseUpEvent = function (e) {
      closeButton.style.backgroundColor = "red";
      let newX = e.clientX;
      let newY = e.clientY;

      let deltaX = newX - originalX;
      let deltaY = newY - originalY;
      console.log("Close button dragged by: ", deltaX, deltaY);

      if (Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) {
        detach();
      }

      document.removeEventListener("mouseup", onMouseUpEvent);
    };

    document.addEventListener("mouseup", onMouseUpEvent);
  });

  return closeButton;

}

function makeDraggable(element) {
  let onMouseMoveEvent;

  element.addEventListener("mousedown", function (e) {
    e.preventDefault();

    let originalX = e.clientX;
    let originalY = e.clientY;
    let originalElementX = element.offsetLeft;
    let originalElementY = element.offsetTop;

    let overlay = document.createElement("div");
    overlay.setAttribute("id", "overlay");
    document.body.appendChild(overlay);

    onMouseMoveEvent = function (e) {
      e.preventDefault();
      e.stopPropagation();

      let newX = e.clientX;
      let newY = e.clientY;

      let deltaX = newX - originalX;
      let deltaY = newY - originalY;

      element.style.left = originalElementX + deltaX + "px";
      element.style.top = originalElementY + deltaY + "px";
    };

    document.addEventListener("mousemove", onMouseMoveEvent);

    document.addEventListener("mouseup", function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMoveEvent);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.removeChild(overlay);
    }, { once: true });
  });
}


function attach() {
  let popup = createPopup();
  document.body.insertBefore(popup, document.body.firstChild); // Insert as the front-most child
  makeDraggable(popup);
  let closeButton = createCloseButton();
  popup.appendChild(closeButton);
  let titleBar = createTitleBar();
  popup.appendChild(titleBar);
}

function detach() {
  let popup = document.getElementById("popup");
  if (popup) {
    popup.remove();
  }
}

function addExternalStylesheet() {
  let link = document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = chrome.runtime.getURL("css/content.css");
  document.head.appendChild(link);
}

addExternalStylesheet();
detach();
attach();
