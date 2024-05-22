chrome.webRequest.onBeforeSendHeaders.addListener(
  async function (details) {
    console.log("url: ", details.url);

    // Only intercept GET requests
    if (details.method !== "GET") {
      return;
    }
    let storageName = "";
    let message = {};


    // Handle sToken and etime
    if (details.url.includes("tsmedia")) {
      storageName = "RecordingsInfo";
      let url = new URL(details.url);
      let stoken = url.searchParams.get("stoken");
      let etime = url.searchParams.get("etime");
      message = {
        url: details.url,
        stoken: stoken,
        etime: etime
      };
    }

    // Handle courses list
    else if (details.url.includes("notifications.api.brightspace.com")) {
      let courseId = details.url.split("/").pop();
      console.log("Course ID: ", courseId);
      storageName = "CoursesList";

      const result = await new Promise((resolve, reject) => {
        chrome.storage.local.get("CoursesList", function (result) {
          if (chrome.runtime.lastError) {
            return reject(chrome.runtime.lastError);
          }
          resolve(result);
        });
      });
      if (!result.CoursesList || !result.CoursesList.coursesList) {
        result.CoursesList = { coursesList: [courseId] };
      }
      let currentCoursesList = result.CoursesList.coursesList;

      console.log("Current courses list: ");

      if (!currentCoursesList.includes(courseId)) {
        currentCoursesList.push(courseId);
      }
      message = {
        coursesList: currentCoursesList
      };
    }

    // Handle cookies
    else if (details.url.includes("mycourses2.mcgill.ca")) {
      storageName = "Cookies";
      let cookies = details.requestHeaders.find(header => header.name.toLowerCase() === 'cookie');
      message = {
        cookies: cookies
      };
    }
    else if (details.url.includes("api/MediaRecordings/dto")) {
      storageName = "MediaRecordings";
      let authorizationHeader = details.requestHeaders.find(header => header.name.toLowerCase() === 'authorization');
      let myMessage = {
        url: details.url,
        authorizationHeader: authorizationHeader
      };
      message = myMessage;
      chrome.storage.local.set({ [storageName]: message });
      console.log("Message stored: ", message);

      console.log("Course ID: ", details.url.split("/").pop());
      storageName = "CoursesDigits";
      let courseDigit = details.url.split("/").pop();
      console.log("Course ID: ", courseDigit);
      storageName = "CoursesDigits";

      const result = await new Promise((resolve, reject) => {
        chrome.storage.local.get("CoursesDigits", function (result) {
          if (chrome.runtime.lastError) {
            return reject(chrome.runtime.lastError);
          }
          resolve(result);
        });
      });
      if (!result.CoursesDigits || !result.CoursesDigits.list) {
        result.CoursesDigits = { list: [courseDigit] };
      }
      let currentCoursesDigitsList = result.CoursesDigits.list;

      console.log("Current courses list: ");

      if (!currentCoursesDigitsList.includes(courseDigit)) {
        currentCoursesDigitsList.push(courseDigit);
      }
      message = {
        list: currentCoursesDigitsList
      };
    }
    // Store the message in chrome.storage
    chrome.storage.local.set({ [storageName]: message });
    console.log("Message stored: ", message);

    return { requestHeaders: details.requestHeaders };
  },
  {
    urls: [
      "https://lrscdn.mcgill.ca/api/tsmedia/*",
      "https://lrswapi.campus.mcgill.ca/api/MediaRecordings/dto/*",
      "https://*.notifications.api.brightspace.com/my-notifications/organizations/*",
      "https://mycourses2.mcgill.ca/d2l/home",]
  },
  ["requestHeaders", "extraHeaders"]
);

// Use chrome.scripting.executeScript instead of chrome.tabs.executeScript
chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["js/content-script.js"],
  });
});
