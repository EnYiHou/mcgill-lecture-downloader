let bearer;
let stoken;
let etime;
let coursesList;
let processedCourses = [];
let downloadingCourses = [];


let errorP = document.createElement("p");
errorP.innerText =
  "Some data is missing or expired.\n\
Please make sure you have all the required data.\n\n\n\
Try the following steps:\n\n\
1. Go to myCourses and login\n\
2. Go to the course you want to download\n\
3. Watch a lecture video of the course\n\
4. Click on the extension icon and verify that everything works\n\
5. If not, try contacting the developer\n\
";


let notFound = document.createElement("p");
notFound.innerText = 
"Can't find your courses?\n\n\
Try the following steps:\n\n\
1. Go to myCourses and login\n\
2. Go to the course you want to download\n\
3. Go to lecture recordings page\n\
4. Click on the extension icon and verify that everything works\n\
5. If not, try contacting the developer\n\
";

notFound.style.marginBottom = "70px";
document.getElementById('main').appendChild(notFound);



function removeItemAll(arr, value) {
  var i = 0;
  while (i < arr.length) {
    if (arr[i] === value) {
      arr.splice(i, 1);
    } else {
      ++i;
    }
  }
  return arr;
}

async function getPayLoad(cookie, courseDigit) {
  try {
    let url = `https://mycourses2.mcgill.ca/d2l/le/lti/${courseDigit}/toolLaunch/3/1579761452?fullscreen=1&d2l_body_type=3`;
    const response = await fetch(url, {
      headers: {
        'cookie': cookie,
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.text();
    const inputFields = extractPayload(data);

    // Convert input fields to URLSearchParams
    return inputFields;
  } catch (error) {
    console.error('Error:', error);
    clearMainDiv();
    document.getElementById('main').appendChild(errorP);
    throw error;
  }
}

function extractPayload(html) {
  const inputFields = {};
  const inputRegex = /<input type="(hidden|submit)" name="([^"]+)" value="([^"]*)">/g;
  let match;
  while ((match = inputRegex.exec(html)) !== null) {
    inputFields[match[2]] = match[3];
  }
  return inputFields;
}

function extractHFCourseID(html) {
  const courseIDRegex = /<input type="hidden" name="HF_CourseID" id="HF_CourseID" value="([^"]*)" \/>/;
  const match = courseIDRegex.exec(html);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

async function getHFCourseIDHTML(payload) {
  try {
    const response = await fetch('https://lrs.mcgill.ca/listrecordings.aspx', {
      method: 'POST',
      headers: {},
      body: new URLSearchParams(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.text();
    return data;
  } catch (error) {
    console.error('Error:', error);
    clearMainDiv();
    document.getElementById('main').appendChild(errorP);
    throw error;
  }
}

async function getCourseMediaList(courseDigit, bearer) {
  const url = `https://lrswapi.campus.mcgill.ca/api/MediaRecordings/dto/${courseDigit}`;
  let response = await fetch(url, {
    headers: {
      'Authorization': bearer,
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  let data = await response.json();
  return data;
}

function setDownloadButton() {
  const downloadButton = document.getElementById('download-button');


  downloadButton.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation()
    let mediaItems = document.querySelectorAll('input[type="checkbox"]:checked');
    if (mediaItems.length === 0) {
      alert('No media selected');
      return;
    }

    downloadButton.disabled = true;
    downloadButton.style.backgroundColor = 'grey';
    downloadButton.textContent = 'Downloading...';
    downloadButton.style.pointer = "default";

    let mediaIDs = [];
    mediaItems.forEach(item => {
      mediaIDs.push(item.value);
    });

    console.log('Selected media IDs: ', mediaIDs);
    for (let rid of mediaIDs) {
      downloadMedia(rid, rid.toString());
    }

  });

}
async function getFileSize(url, params) {
  try {
    const paramString = new URLSearchParams(params).toString();
    const fullUrl = `${url}?${paramString}`;
    const response = await fetch(fullUrl, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const contentRange = response.headers.get('Content-Range');
    const totalBytes = parseInt(contentRange.split('/')[1], 10);
    console.log("Full url: ", fullUrl);
    return totalBytes;
  } catch (error) {
    console.error('Error getting file size:', error);

    clearMainDiv();
    document.getElementById('main').appendChild(errorP);
    throw error;
  }
}

async function downloadMedia(rid, filename, f = "VGA") {
  try {
    downloadingCourses.push(rid);
    const params = {
      f: f,
      rid: rid,
      stoken: stoken,
      etime: etime,
    };

    const totalBytes = await getFileSize("https://lrscdn.mcgill.ca/api/tsmedia/", params);
    console.log(`Total bytes: ${totalBytes}`);

    const headers = {
      "Range": `bytes=0-${totalBytes - 1}`,
    };

    const paramString = new URLSearchParams(params).toString();
    const fullUrl = `https://lrscdn.mcgill.ca/api/tsmedia/?${paramString}`;
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: headers,
    });

    if (response.status === 206) {
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      chrome.downloads.download({
        url: url,
        filename: `${filename}.ts`,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(`Error downloading video: ${chrome.runtime.lastError}`);
          alert(`Error downloading video: ${chrome.runtime.lastError}`);
        } else {
          console.log('Download started with ID:', downloadId);
        }
      });
    } else {
      console.error(`Error downloading video: ${response.status}`);
      alert(`Error downloading video: ${response.status}`);
    }

    removeItemAll(downloadingCourses, rid);
    if (downloadingCourses.length === 0) {
      alert('All downloads completed');
      let downloadButton = document.getElementById('download-button');
      downloadButton.disabled = false;
      downloadButton.style.backgroundColor = 'blue';
      downloadButton.textContent = 'Download';
      downloadButton.style.pointer = "pointer";
    }
  } catch (error) {
    removeItemAll(downloadingCourses, rid);
    if (downloadingCourses.length === 0) {
      alert('All downloads completed');
      let downloadButton = document.getElementById('download-button');
      downloadButton.disabled = false;
      downloadButton.style.backgroundColor = 'blue';
      downloadButton.textContent = 'Download';
      downloadButton.style.pointer = "pointer";
    }
    console.error('Error downloading media:', error);
    alert('Error downloading media:', error);
  }
}

async function createCourseDiv(courseDigit, context_title = null) {
  console.log(courseDigit);
  if (courseDigit == null) {
    return;
  }
  let mediaList = await getCourseMediaList(courseDigit, bearer);
  console.log("Media List: ", mediaList);

  // Create the course div
  let courseDiv = document.createElement('div');
  courseDiv.className = 'courseDiv';
  if (context_title == null) {
    context_title = mediaList[0].courseName;
  }
  courseDiv.textContent = `${context_title}, ID: ${courseDigit}`;

  // Create the media list div
  let mediaListDiv = document.createElement('div');
  mediaListDiv.className = 'media-list';

  // Populate the media list
  mediaList.forEach(media => {
    let mediaItem = document.createElement('div');
    mediaItem.className = 'media-item';
    let mediaInfo = document.createElement('div');
    mediaItem.appendChild(mediaInfo);
    mediaInfo.style.display = 'block';
    mediaInfo.style.width = '80%';

    // Add recording name
    let recordingName = document.createElement('p');
    recordingName.textContent = media.recordingName;
    recordingName.style.padding = '5px';
    mediaInfo.appendChild(recordingName);

    // Add recording time
    let recordingTime = document.createElement('p');
    recordingTime.textContent = media.dateTime;;
    recordingTime.style.padding = '5px';
    mediaInfo.appendChild(recordingTime);

    // Add checkbox
    let checkbox = document.createElement('input');
    checkbox.className = 'media-checkbox';
    checkbox.type = 'checkbox';
    checkbox.value = media.id;
    mediaItem.appendChild(checkbox);

    // Add media item to media list
    mediaItem.addEventListener("mouseover", function () {
      mediaItem.style.backgroundColor = "lightgrey";
      mediaItem.style.transition = "background-color 0.5s";

      mediaItem.addEventListener("mouseout", function () {
        mediaItem.style.backgroundColor = "white";
      });
    });
    mediaItem.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    mediaListDiv.appendChild(mediaItem);
  });

  // Append media list to course div 
  courseDiv.appendChild(mediaListDiv);
  mediaListDiv.style.display = 'none';

  // Add click event to toggle media list
  courseDiv.addEventListener('click', () => {
    mediaListDiv.style.display = mediaListDiv.style.display === 'none' ? 'block' : 'none';
  });

  courseDiv.addEventListener("mouseover", function () {
    courseDiv.style.backgroundColor = "lightblue";
    courseDiv.style.transition = "background-color 0.5s";

    courseDiv.addEventListener("mouseout", function () {
      courseDiv.style.backgroundColor = "lightgrey";
    });
  });

  // Append course div to main container
  let main = document.getElementById('main');
  main.insertBefore(courseDiv, main.firstChild);
}

async function processCourse(course, cookies, bearer) {
  let payload = await getPayLoad(cookies, course);
  let context_title = payload.context_title;
  console.log(payload);
  let courseIDHTML = await getHFCourseIDHTML(payload);
  let courseDigit = extractHFCourseID(courseIDHTML);
  if (courseDigit == null) {
    console.log("Course digit not found");
    console.log("Course ID: ", payload);
  }
  processedCourses.push(courseDigit);
  createCourseDiv(courseDigit, context_title);
}

async function processAllCourses(coursesList, cookies, bearer) {
  const promises = coursesList.map(course => processCourse(course, cookies, bearer));

  const CoursesDigits = await getFromStorage("CoursesDigits");

  await Promise.all(promises);
  if (CoursesDigits.CoursesDigits) {
    let CoursesDigitsList = CoursesDigits.CoursesDigits.list;
    if (CoursesDigitsList == null) {
      return;
    }
    for (let courseDigit of CoursesDigitsList) {
      if (processedCourses.includes(courseDigit)) {
        continue;
      }
      createCourseDiv(courseDigit);
    }
  }
}


document.addEventListener('DOMContentLoaded', async function () {
  const main = document.getElementById('main');
  main.style.width = '100%';
  main.style.height = '90%';

  setDownloadButton();
  try {
    const recordingsInfoResult = await getFromStorage("RecordingsInfo");
    const mediaRecordingsResult = await getFromStorage("MediaRecordings");
    const coursesListResult = await getFromStorage("CoursesList");
    const cookiesResult = await getFromStorage("Cookies");

    if (!recordingsInfoResult.RecordingsInfo || !mediaRecordingsResult.MediaRecordings || !coursesListResult.CoursesList || !cookiesResult.Cookies) {
      clearMainDiv();
      document.getElementById('main').appendChild(errorP);
      return;
    }
    stoken = recordingsInfoResult.RecordingsInfo.stoken;
    etime = recordingsInfoResult.RecordingsInfo.etime;
    bearer = mediaRecordingsResult.MediaRecordings.authorizationHeader.value;
    coursesList = coursesListResult.CoursesList.coursesList;
    const cookies = cookiesResult.Cookies.cookies;


    console.log("bearer: ", bearer);
    console.log("stoken: ", stoken);
    console.log("etime: ", etime);
    console.log("coursesList: ", coursesList);
    console.log("cookies: ", cookies);


    if (!stoken || !etime || !bearer || !coursesList || !cookies) {
      p.innerText = message;
      main.appendChild(p);
    } else {
      processAllCourses(coursesList, cookies, bearer);
    }
  } catch (error) {
    console.error("Error: ", error);
    clearMainDiv();
    document.getElementById('main').appendChild(errorP);
  }
});

function getFromStorage(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  });
}


function clearMainDiv() {
  const main = document.getElementById('main');
  while (main.firstChild) {
    main.removeChild(main.firstChild);
  }
}
