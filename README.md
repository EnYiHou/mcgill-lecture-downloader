
# McGill Lecture Downloader Chrome Extension

This Google Chrome extension allows you to download lecture recordings from McGill's myCourses platform. Follow the instructions below to ensure you have all the required data to use this extension effectively.

## Installation

1. Clone or download this repository.
   - To clone the repository, use `git clone https://github.com/EnYiHou/mcgill-lecture-downloader.git`.
   - Alternatively, you can download the `crx` file from the releases section.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable "Developer mode" in the top right corner.
4. Load the downloaded extension to Google Chrome.
   - If you cloned the repository, click on "Load unpacked" and select the directory where you downloaded/cloned this repository.
   - If you downloaded the `crx` file, drag and drop it into the Chrome extensions page.

## Usage Instructions

1. Go to [myCourses](https://mycourses2.mcgill.ca/d2l/home) and log in.
2. Navigate to the course you want to download lecture recordings from.
3. Watch a lecture video of the course.
4. Click on the extension icon in the Chrome toolbar to verify that everything works.
5. If the extension does not work, please open an issue for assistance.


## Development

### Overview

This extension was developed by analyzing the McGill lecture recording system and identifying the necessary data required to download lectures. Key variables used in the code include:

- `cookie`: The cookie value used for authentication and session management.
- `bearer`: Authorization token
- `stoken`: Session token
- `etime`: Expiration time


### Key Functions

#### Data Extraction and Validation

- **getPayLoad**: Fetches the payload required for authentication and extracts necessary input fields from the HTML response.
- **getHFCourseIDHTML**: Uses the payload to make a POST request and retrieve the course ID.

### UI Elements and User Interaction

To ensure the Chrome extension does not create a standard popup that disappears when the cursor loses focus, we created a custom popup using JavaScript:

- **createPopup**: Creates a custom popup element with an embedded iframe.

- **makeDraggable**: Makes the popup draggable by attaching mouse event listeners.
- **attach and detach**: Attaches and removes the custom popup to the DOM, respectively.

### Background Script

The background script is essential for capturing the required data, such as authorization tokens, course lists, and cookies:

- **chrome.webRequest.onBeforeSendHeaders.addListener**: Intercepts HTTP requests to capture necessary data and store it in Chrome's local storage.

## Contributing

If you would like to contribute to this project, please fork the repository and submit a pull request.
