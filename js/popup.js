
const { createFFmpeg, fetchFile } = FFmpeg;



async function runFFmpeg(inputFileName, outputFileName, commandStr, fileOrUrl) {
  let ffmpeg = createFFmpeg({
    corePath: chrome.runtime.getURL("lib/ffmpeg-core.js"),
    log: false,
    mainName: 'main'
  });

  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load();
  }

  const commandList = commandStr.trim().split(/\s+/);
  if (commandList.shift() !== 'ffmpeg') {
    alert('Please start the command with "ffmpeg"');
    return;
  }

  ffmpeg.FS('writeFile', inputFileName, await fetchFile(fileOrUrl));

  console.log('Running FFmpeg command:', commandList);

  try {
    await ffmpeg.run(...commandList);
  } catch (err) {
    console.error('Error running FFmpeg:', err);
    alert(`Error running FFmpeg: ${err.message || err}`);
    return;
  }
  try {
    const data = ffmpeg.FS('readFile', outputFileName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });

    ffmpeg.FS('unlink', inputFileName);
    ffmpeg.FS('unlink', outputFileName);

    downloadFile(blob, outputFileName);
  }
  catch (error) {
    console.error('Error during file processing:', error);
  }
}

function downloadFile(blob, fileName) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  catch (error) {
    console.error('Unable to create download link or download file:', error);
  }
}


let bearer;
let stoken;
let etime;
let coursesList;
let processedCourses = [];
let downloadingCourses = [];
let downloadedItems = new Set();


let overwriteDownloadedItems = async () => {
  console.log('Updating downloaded items:', downloadedItems);
  let downloadedItemsArray = Array.from(downloadedItems);
  await new Promise((resolve, reject) => {
    chrome.storage.local.set({ downloadedItems: downloadedItemsArray }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  }).then(() => {
    console.log('Downloaded items have been updated');

    // Make all downloaded items green
    const mediaItems = Array.from(document.querySelectorAll('.media-item'));
    mediaItems.forEach(item => {
      const filename = item.getAttribute('filename');
      if (downloadedItems.has(filename)) {
        item.style.backgroundColor = 'lightgreen';
      }
    });
  });
};


let info_div = document.createElement("div");
let courses_div = document.createElement("div");

info_div.setAttribute("id", "info");
courses_div.setAttribute("id", "courses");


document.body.appendChild(info_div);
document.body.appendChild(courses_div);


const instructionContent = document.createElement("div");
instructionContent.id = "instructionContent";

const instructionContentText = document.createElement("div");
instructionContentText.id = "instructionContentText";

instructionContent.appendChild(instructionContentText);

instructionContent.classList.add("show");


const closeBtn = document.createElement("button");
closeBtn.id = "instructionCloseBtn";
closeBtn.textContent = "X";
closeBtn.addEventListener("click", () => {
  instructionContent.classList.toggle("show");
});

instructionContent.appendChild(closeBtn);

const cannotFindCourses = document.createElement("div");
cannotFindCourses.innerHTML = `
  <h3>Can't find your lectures?</h3>
  <p>Try the following steps:</p>
  <ol>
    <li>Go to myCourses and login</li>
    <li>Go to the course you want to download</li>
    <li>Start playing a lecture video of the course</li>
    <li>Click on the extension icon, the course should appear in the list</li>
    <li>If the course still doesn't appear, try contacting the developer</li>
  </ol>
`;

instructionContentText.appendChild(cannotFindCourses);

const seperator = document.createElement("hr");
instructionContentText.appendChild(seperator);

const features = document.createElement("div");
features.innerHTML = `
  <h3>Features</h3>
  <ul>
    <li>Download multiple videos at once, select the videos you want to download and click the download button. <strong> DO NOT CLOSE THE TAB WHEN DOWNLOADING </strong></li>
    <li>Downloaded videos are marked with a green background, right-click on a video to manually toggle its download status</li>
    <li>Remove courses from the list by right-clicking on the course (removed courses can be added back by reaccessing MyCourses)</li>
  </ul>
`;

instructionContentText.appendChild(features);


document.body.appendChild(instructionContent);


const instructionBtn = document.createElement("button");
instructionBtn.id = "instructionBtn";
instructionBtn.textContent = "Help";


instructionBtn.addEventListener("click", () => {
  instructionContent.classList.toggle("show");
});

document.body.appendChild(instructionBtn);

(async () => {
  const result = await new Promise((resolve, reject) => {
    chrome.storage.local.get({ downloadedItems: [] }, (res) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(res);
      }
    });
  });

  const downloadedItemsArray = Array.isArray(result.downloadedItems) ? result.downloadedItems : [];
  downloadedItems = new Set(downloadedItemsArray);
})();


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

    return inputFields;
  } catch (error) {
    console.error('Error:', error);
    clearMainDiv();
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
    let mediaItems = Array.from(document.querySelectorAll('.media-checkbox:checked'));
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
      let fileName = item.getAttribute('filename');
      downloadMedia(item.value, fileName, item.getAttribute('videoType'));
    });




  });

}
async function getFileSize(url, params, tryCount = 10) {
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

    return totalBytes;
  } catch (error) {
    if (tryCount > 0) {
      return getFileSize(url, params, tryCount - 1);
    } else {
      throw error;
    }
  }
}


async function downloadMedia(rid, filename, f = "VGA") {
  try {
    downloadingCourses.push(rid);

    const params = { f, rid, stoken, etime };
    const totalBytes = await getFileSize("https://lrscdn.mcgill.ca/api/tsmedia/", params);

    const headers = { "Range": `bytes=0-${totalBytes - 1}` };
    const paramString = new URLSearchParams(params).toString();
    const fullUrl = `https://lrscdn.mcgill.ca/api/tsmedia/?${paramString}`;

    const response = await fetch(fullUrl, { method: 'GET', headers });
    if (response.status !== 206) {
      console.error(`Error downloading .ts file: ${response.status}`);
      alert(`Error: ${response.status}`);
      return;
    }

    const tsBlob = await response.blob();

    const inputFileName = 'input.ts';
    const outputFileName = `${filename}.mp4`;
    const commandStr = `ffmpeg -y -i ${inputFileName} -c copy ${outputFileName}`;

    await runFFmpeg(inputFileName, outputFileName, commandStr, tsBlob);

    removeItemAll(downloadingCourses, rid);


    downloadedItems.add(filename);

    // Convert Set back to an array for storage
    await overwriteDownloadedItems();


    if (downloadingCourses.length === 0) {
      // alert('All downloads completed');
      let downloadButton = document.getElementById('download-button');
      downloadButton.disabled = false;
      downloadButton.style.backgroundColor = 'blue';
      downloadButton.textContent = 'Download';
      downloadButton.style.pointer = "pointer";
    }

  } catch (error) {
    removeItemAll(downloadingCourses, rid);

    if (downloadingCourses.length === 0) {
      // alert('All downloads completed');
      let downloadButton = document.getElementById('download-button');
      downloadButton.disabled = false;
      downloadButton.style.backgroundColor = 'blue';
      downloadButton.textContent = 'Download';
      downloadButton.style.pointer = "pointer";
    }
    console.error('Error downloading media:', error);
    alert(`Error downloading media: ${error.message || error}`);
  }
}



async function createCourseDiv(courseDigit, context_title = null, courseListID = null) {

  if (courseDigit == null) {
    return;
  }
  let mediaList = await getCourseMediaList(courseDigit, bearer);


  let courseDiv = document.createElement('div');
  courseDiv.setAttribute('courseDigit', courseDigit);
  courseDiv.className = 'courseDiv';


  if (context_title == null) {
    context_title = mediaList[0].courseName;
  }
  let courseDivTitle = document.createElement('div');
  courseDivTitle.className = 'courseDivTitle';
  let courseDivTitleText = document.createElement('p');
  courseDivTitleText.textContent = context_title + ", ID: " + courseDigit;


  courseDivTitle.appendChild(courseDivTitleText);

  let dropDownIcon = document.createElement('i');
  dropDownIcon.className = 'fas fa-caret-down';
  courseDivTitle.appendChild(dropDownIcon);

  courseDiv.appendChild(courseDivTitle);



  let mediaListDiv = document.createElement('div');
  mediaListDiv.className = 'media-list';
  mediaListDiv.classList.add('media-list');

  let selectAllDiv = document.createElement('div');
  selectAllDiv.className = 'select-all-div';


  let selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.className = "select-all-checkbox";


  let selectAllLabel = document.createElement("label");
  selectAllLabel.textContent = "Select All";


  selectAllDiv.append(selectAllCheckbox, selectAllLabel);


  let checkboxes = Array.from(document.querySelectorAll(".checkbox-class")); // Update with actual checkbox class


  const toggleCheckboxes = (isChecked) => {
    checkboxes.forEach(checkbox => checkbox.checked = isChecked);
  };

  mediaListDiv.appendChild(selectAllDiv);



  let selectNotDownloadedDiv = document.createElement('div');
  selectNotDownloadedDiv.className = 'select-not-downloaded-div';

  let selectNotDownloadedCheckbox = document.createElement("input");
  selectNotDownloadedCheckbox.type = "checkbox";
  selectNotDownloadedCheckbox.className = "select-not-downloaded-checkbox";

  let selectNotDownloadedLabel = document.createElement("label");
  selectNotDownloadedLabel.textContent = "Select Not Downloaded";

  selectNotDownloadedDiv.append(selectNotDownloadedCheckbox, selectNotDownloadedLabel);

  const toggleNotDownloadedCheckboxes = (isChecked) => {
    checkboxes.forEach(checkbox => {
      const filename = checkbox.getAttribute('filename');
      if (downloadedItems.has(filename)) {
        return;
      }
      checkbox.checked = isChecked;
    });
  };

  mediaListDiv.appendChild(selectNotDownloadedDiv);


  const checkAllChecked = () => {
    const allChecked = Array.from(checkboxes).every(checkbox => checkbox.checked);
    selectAllCheckbox.checked = allChecked;
  };

  const checkNotDownloadedChecked = () => {
    const notDownloadedChecked = Array.from(checkboxes).filter(checkbox => {
      const filename = checkbox.getAttribute('filename');
      return !downloadedItems.has(filename);
    }).every(checkbox => checkbox.checked) && checkboxes.some(checkbox => !downloadedItems.has(checkbox.getAttribute('filename')));

    selectNotDownloadedCheckbox.checked = notDownloadedChecked;
  };




  selectAllCheckbox.addEventListener("change", (event) => {
    event.stopPropagation();
    toggleCheckboxes(selectAllCheckbox.checked);
    checkAllChecked();
    checkNotDownloadedChecked();
  });


  selectAllCheckbox.addEventListener("click", (event) => {
    event.stopPropagation();
  });


  selectAllDiv.addEventListener("click", (event) => {
    event.stopPropagation();
    selectAllCheckbox.checked = !selectAllCheckbox.checked;
    toggleCheckboxes(selectAllCheckbox.checked);
    checkAllChecked();
    checkNotDownloadedChecked();
  });



  selectNotDownloadedCheckbox.addEventListener("change", (event) => {
    event.stopPropagation();
    toggleNotDownloadedCheckboxes(selectNotDownloadedCheckbox.checked);
    checkAllChecked();
    checkNotDownloadedChecked();
  });

  selectNotDownloadedCheckbox.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  selectNotDownloadedDiv.addEventListener("click", (event) => {
    event.stopPropagation();
    selectNotDownloadedCheckbox.checked = !selectNotDownloadedCheckbox.checked;
    toggleNotDownloadedCheckboxes(selectNotDownloadedCheckbox.checked);
    checkAllChecked();
    checkNotDownloadedChecked();
  });





  for (let i = 0; i < mediaList.length; i++) {
    let media = mediaList[i];
    let mediaItem = document.createElement('div');



    let filename = `${mediaList[0].courseName}_${i}`.replace(/\s+/g, '');

    mediaItem.addEventListener('contextmenu', async (event) => {
      event.stopPropagation();
      event.preventDefault();

      if (!downloadedItems.has(filename)) {
        downloadedItems.add(filename);
        mediaItem.style.backgroundColor = 'lightgreen';
      } else {
        downloadedItems.delete(filename);
        mediaItem.style.backgroundColor = '#f0f0f0';
      }

      await overwriteDownloadedItems();

    });


    mediaItem.setAttribute('filename', filename);

    if (downloadedItems.has(filename)) {
      mediaItem.style.backgroundColor = 'lightgreen';
    }

    mediaItem.className = 'media-item';
    let mediaInfo = document.createElement('div');
    mediaInfo.className = 'media-info';
    mediaItem.appendChild(mediaInfo);


    let recordingName = document.createElement('p');
    recordingName.innerHTML = "<strong>Recording Name:</strong> " + (media.recordingName ? media.recordingName : "Recording Name Unavailable");
    mediaInfo.appendChild(recordingName);


    let recordingTime = document.createElement('p');
    recordingTime.innerHTML = "<strong>Recording Time:</strong> " + media.recordingTime;
    mediaInfo.appendChild(recordingTime);

    let downloadFileNames = document.createElement('p');
    downloadFileNames.innerHTML = "<strong>Download File Name:</strong> " + filename; mediaInfo.appendChild(downloadFileNames);


    let checkbox = document.createElement('input');
    checkbox.className = 'media-checkbox';
    checkbox.type = 'checkbox';
    checkbox.setAttribute('filename', filename);
    checkbox.setAttribute('videoType', media.sources[0].label);
    checkbox.value = media.id;

    checkbox.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    mediaItem.addEventListener('click', (event) => {
      event.stopPropagation();
      checkbox.checked = !checkbox.checked;
      checkAllChecked();
      checkNotDownloadedChecked();
    });

    mediaItem.appendChild(checkbox);
    checkboxes.push(checkbox);


    mediaListDiv.appendChild(mediaItem);
  };


  courseDiv.appendChild(mediaListDiv);


  courseDiv.addEventListener('click', () => {
    mediaListDiv.classList.toggle('expanded');
  });
  courseDivTitle.addEventListener('contextmenu', async function (ev) {
    ev.preventDefault();
    const CourseListIDDigits = await getFromStorage("CoursesList");
    let CoursesListDigits = CourseListIDDigits.CoursesList.coursesList;
    CoursesListDigits = removeItemAll(CoursesListDigits, courseListID);
    console.log("CoursesListDigits: ", CoursesListDigits);
    console.log("REMOVING Course digit: ", courseListID);
    message = {
      coursesList: CoursesListDigits
    }
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ ["CoursesList"]: message }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          console.log(`Course ${courseListID} has been removed.`);
          resolve();
        }
      });
    }
    );

    const CoursesDigits = await getFromStorage("CoursesDigits");
    let CoursesDigitsList = CoursesDigits.CoursesDigits.list;
    CoursesDigitsList = removeItemAll(CoursesDigitsList, courseDigit);
    console.log("CoursesDigitsList: ", CoursesDigitsList);
    console.log("REMOVING Course digit: ", courseDigit);
    message = {
      list: CoursesDigitsList
    }
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ ["CoursesDigits"]: message }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          console.log(`Course ${courseDigit} has been removed.`);
          resolve();
        }
      });
    }
    );

    courseDiv.remove();
    return false;
  }, false);


  courses_div.insertBefore(courseDiv, courses_div.firstChild);
}

async function processCourse(course, cookies, bearer) {
  let payload = await getPayLoad(cookies, course);
  let context_title = payload.context_title;
  let courseIDHTML = await getHFCourseIDHTML(payload);
  let courseDigit = extractHFCourseID(courseIDHTML);
  if (courseDigit == null) {


  }
  processedCourses.push(courseDigit);
  createCourseDiv(courseDigit, context_title, course);
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
  courses_div.style.width = '100%';
  courses_div.style.height = '90%';

  setDownloadButton();
  try {

    function createRow(labelText, valueText, exists) {
      const rowDiv = document.createElement("div");
      rowDiv.classList.add("info-row");

      const labelEl = document.createElement("p");
      labelEl.classList.add("info-label");
      labelEl.textContent = labelText;


      const valueWrapper = document.createElement("div");
      valueWrapper.classList.add("info-value-wrapper");

      const valueEl = document.createElement("p");
      valueEl.classList.add("info-value");

      valueEl.classList.add(exists ? "exists" : "not-found");
      valueEl.textContent = valueText;


      labelEl.addEventListener("click", () => {
        rowDiv.classList.toggle("expanded");
      });

      valueWrapper.addEventListener("click", () => {
        rowDiv.classList.toggle("expanded");
      });

      valueWrapper.appendChild(valueEl);
      rowDiv.appendChild(labelEl);
      rowDiv.appendChild(valueWrapper);

      return rowDiv;
    }


    const recordingsInfoResult = await getFromStorage("RecordingsInfo");
    const mediaRecordingsResult = await getFromStorage("MediaRecordings");
    const coursesListResult = await getFromStorage("CoursesList");
    const cookiesResult = await getFromStorage("Cookies");


    info_div.appendChild(
      createRow(
        "Recordings Info",
        recordingsInfoResult.RecordingsInfo
          ? JSON.stringify(recordingsInfoResult.RecordingsInfo, null, 2)
          : "Not Found",
        !!recordingsInfoResult.RecordingsInfo
      )
    );

    info_div.appendChild(
      createRow(
        "Media Recordings",
        mediaRecordingsResult.MediaRecordings
          ? JSON.stringify(mediaRecordingsResult.MediaRecordings, null, 2)
          : "Not Found",
        !!mediaRecordingsResult.MediaRecordings
      )
    );

    info_div.appendChild(
      createRow(
        "Courses List",
        coursesListResult.CoursesList
          ? JSON.stringify(coursesListResult.CoursesList, null, 2)
          : "Not Found",
        !!coursesListResult.CoursesList
      )
    );

    info_div.appendChild(
      createRow(
        "Cookies",
        cookiesResult.Cookies
          ? JSON.stringify(cookiesResult.Cookies, null, 2)
          : "Not Found",
        !!cookiesResult.Cookies
      )
    );




    if (!recordingsInfoResult.RecordingsInfo || !mediaRecordingsResult.MediaRecordings || !coursesListResult.CoursesList || !cookiesResult.Cookies) {
      clearMainDiv();

      return;
    }
    stoken = recordingsInfoResult.RecordingsInfo.stoken;
    etime = recordingsInfoResult.RecordingsInfo.etime;
    bearer = mediaRecordingsResult.MediaRecordings.authorizationHeader.value;
    coursesList = coursesListResult.CoursesList.coursesList;
    const cookies = cookiesResult.Cookies.cookies;











    if (!stoken || !etime || !bearer || !coursesList || !cookies) {
      p.innerText = message;
      courses_div.appendChild(p);
    } else {
      processAllCourses(coursesList, cookies, bearer);
    }
  } catch (error) {
    console.error("Error: ", error);
    clearMainDiv();

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
  while (courses_div.firstChild) {
    courses_div.removeChild(courses_div.firstChild);
  }
  courses_div.appendChild(cannotFindCourses);

}
