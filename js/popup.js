


let bearer;
let stoken;
let etime;
let coursesList;
let processedCourses = [];
let downloadingCourses = [];

// main - [info, courses]
let info_div = document.createElement("div");
let courses_div = document.createElement("div");

info_div.setAttribute("id", "info");
courses_div.setAttribute("id", "courses");


document.body.appendChild(info_div);
document.body.appendChild(courses_div);


const instructionContent = document.createElement("div");
instructionContent.id = "instructionContent";
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
  <h3>Can't find your courses?</h3>
  <p>Try the following steps:</p>
  <ol>
    <li>Go to myCourses and login</li>
    <li>Go to the course you want to download</li>
    <li>Watch a lecture video of the course</li>
    <li>Click on the extension icon and verify that everything works</li>
    <li>If not, try contacting the developer</li>
  </ol>
`;

instructionContent.appendChild(cannotFindCourses);

const seperator = document.createElement("hr");
instructionContent.appendChild(seperator);

const features = document.createElement("div");
features.innerHTML = `
  <h3>Features</h3>
  <ul>
    <li>Download multiple videos at once, select the videos you want to download and click the download button. <strong> DO NOT CLOSE THE TAB WHEN DOWNLOADING </strong></li>
    <li>Mark videos as downloaded by right-clicking on the specific video</li>
    <li>Remove courses from the list by right-clicking on the course (removed courses can be added back by reaccessing MyCourses)</li>
  </ul>
`;

instructionContent.appendChild(features);


document.body.appendChild(instructionContent);


// 2. CREATE THE INSTRUCTIONS BUTTON
const instructionBtn = document.createElement("button");
instructionBtn.id = "instructionBtn";
instructionBtn.textContent = "Instructions";


// 3. TOGGLE INSTRUCTIONS VISIBILITY ON BUTTON CLICK
instructionBtn.addEventListener("click", () => {
  instructionContent.classList.toggle("show");
});

// 4. APPEND TO THE DOCUMENT
document.body.appendChild(instructionBtn);

let downloadedItems = [];
(async () => {
  downloadedItems = await new Promise((resolve, reject) => {
    chrome.storage.local.get({ downloadedItems: [] }, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result.downloadedItems);
      }
    });
  });
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

    // Convert input fields to URLSearchParams
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
      let fileName = item.getAttribute('filename');
      downloadMedia(item.value, fileName, item.getAttribute('videoType'));
    });

    // console.log('Selected media IDs: ', mediaIDs);


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
    // console.log("Full url: ", fullUrl);
    return totalBytes;
  } catch (error) {
    console.error('Error getting file size:', error);

    clearMainDiv();

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
    // console.log(`Total bytes: ${totalBytes}`);

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
          // console.log('Download started with ID:', downloadId);
        }
      });
    } else {
      console.error(`Error downloading video: ${response.status}`);
      alert(`Error downloading video: ${response.status}`);
    }

    removeItemAll(downloadingCourses, rid);
    let result = await new Promise((resolve, reject) => {
      chrome.storage.local.get({ downloadedItems: [] }, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(result);
        }
      });
    });

    let downloadedItems = result.downloadedItems;
    if (!downloadedItems.includes(filename)) {
      downloadedItems.push(filename);
    }
    document.querySelectorAll(`div[filename="${filename}"]`).forEach(div => {
      div.style.backgroundColor = 'lightgreen';
    });

    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ downloadedItems: downloadedItems }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          console.log(`Item ${filename} has been marked as downloaded.`);
          resolve();
        }
      });
    });


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

async function createCourseDiv(courseDigit, context_title = null, courseListID = null) {
  // console.log(courseDigit);
  if (courseDigit == null) {
    return;
  }
  let mediaList = await getCourseMediaList(courseDigit, bearer);
  // console.log("Media List: ", mediaList);

  // Create the course div
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


  // Create the media list div
  let mediaListDiv = document.createElement('div');
  mediaListDiv.className = 'media-list';
  mediaListDiv.classList.add('media-list');

  let selectAllDiv = document.createElement('div');
  selectAllDiv.className = 'select-all-div';

  // Create the "Select All" checkbox
  let selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.className = "select-all-checkbox";

  // Create the label for "Select All"
  let selectAllLabel = document.createElement("label");
  selectAllLabel.textContent = "Select All";

  // Append checkbox and label to selectAllDiv
  selectAllDiv.append(selectAllCheckbox, selectAllLabel);

  // Get all checkboxes (assuming they have a class)
  let checkboxes = Array.from(document.querySelectorAll(".checkbox-class")); // Update with actual checkbox class

  // Function to toggle all checkboxes
  const toggleCheckboxes = (isChecked) => {
    checkboxes.forEach(checkbox => checkbox.checked = isChecked);
  };

  // Event listener for the checkbox itself
  selectAllCheckbox.addEventListener("change", (event) => {
    event.stopPropagation(); // Prevent bubbling to selectAllDiv
    toggleCheckboxes(selectAllCheckbox.checked);
  });

  // Prevent checkbox click from triggering the div's click event
  selectAllCheckbox.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Event listener for the div (alternative selection)
  selectAllDiv.addEventListener("click", (event) => {
    event.stopPropagation();
    selectAllCheckbox.checked = !selectAllCheckbox.checked;
    toggleCheckboxes(selectAllCheckbox.checked);
  });

  // Append the selectAllDiv to mediaListDiv
  mediaListDiv.appendChild(selectAllDiv);



  // Populate the media list
  for (let i = 0; i < mediaList.length; i++) {
    let media = mediaList[i];
    let mediaItem = document.createElement('div');



    let filename = `${i}_${context_title}`;

    mediaItem.addEventListener('contextmenu', async (event) => {
      event.stopPropagation();
      event.preventDefault();


      let downloadedItems = await new Promise((resolve, reject) => {
        chrome.storage.local.get({ downloadedItems: [] }, (result) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(result.downloadedItems);
          }
        });
      });

      if (!downloadedItems.includes(filename)) {
        downloadedItems.push(filename);
        mediaItem.style.backgroundColor = 'lightgreen';
      } else {
        downloadedItems = removeItemAll(downloadedItems, filename);
        mediaItem.style.backgroundColor = 'lightgrey';
      }

      await new Promise((resolve, reject) => {
        chrome.storage.local.set({ downloadedItems: downloadedItems }, () => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            console.log(`Item ${filename} has been added to downloaded items.`);
            resolve();
          }
        });
      });

    });


    mediaItem.setAttribute('filename', filename);

    if (downloadedItems.includes(filename)) {
      mediaItem.style.backgroundColor = 'lightgreen';
    }

    mediaItem.className = 'media-item';
    let mediaInfo = document.createElement('div');
    mediaInfo.className = 'media-info';
    mediaItem.appendChild(mediaInfo);

    // Add recording name
    let recordingName = document.createElement('p');
    recordingName.innerHTML = "<strong>Recording Name:</strong> " + (media.recordingName ? media.recordingName : "Recording Name Unavailable");
    mediaInfo.appendChild(recordingName);

    // Add recording time
    let recordingTime = document.createElement('p');
    recordingTime.innerHTML = "<strong>Recording Time:</strong> " + media.recordingTime;
    mediaInfo.appendChild(recordingTime);

    let downloadFileNames = document.createElement('p');
    downloadFileNames.innerHTML = "<strong>Download File Name:</strong> " + filename; mediaInfo.appendChild(downloadFileNames);

    // Add checkbox
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
      const allChecked = Array.from(checkboxes).every(checkbox => checkbox.checked);
      selectAllCheckbox.checked = allChecked;
    });

    mediaItem.appendChild(checkbox);
    checkboxes.push(checkbox);


    mediaListDiv.appendChild(mediaItem);
  };

  // Append media list to course div 
  courseDiv.appendChild(mediaListDiv);

  // Add click event to toggle media list
  courseDiv.addEventListener('click', () => {
    mediaListDiv.classList.toggle('expanded');
  });
  courseDiv.addEventListener('contextmenu', async function (ev) {
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

  // Append course div to main container
  courses_div.insertBefore(courseDiv, courses_div.firstChild);
}

async function processCourse(course, cookies, bearer) {
  let payload = await getPayLoad(cookies, course);
  let context_title = payload.context_title;
  let courseIDHTML = await getHFCourseIDHTML(payload);
  let courseDigit = extractHFCourseID(courseIDHTML);
  if (courseDigit == null) {
    // console.log("Course digit not found");
    // console.log("Course ID: ", payload);
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

      // We'll wrap the value in a separate div so we can animate its max-height
      const valueWrapper = document.createElement("div");
      valueWrapper.classList.add("info-value-wrapper");

      const valueEl = document.createElement("p");
      valueEl.classList.add("info-value");
      // Add a class for coloring
      valueEl.classList.add(exists ? "exists" : "not-found");
      valueEl.textContent = valueText;

      // Toggle expand on label click
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

    // 2. Fetch data (example usage)
    const recordingsInfoResult = await getFromStorage("RecordingsInfo");
    const mediaRecordingsResult = await getFromStorage("MediaRecordings");
    const coursesListResult = await getFromStorage("CoursesList");
    const cookiesResult = await getFromStorage("Cookies");

    // 3. Build and append each row
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




    // console.log("bearer: ", bearer);
    // console.log("stoken: ", stoken);
    // console.log("etime: ", etime);
    // console.log("coursesList: ", coursesList);
    // console.log("cookies: ", cookies);


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
  courses_div.appendChild(notFound);

}
