const fileInput = document.getElementById("fileInput");
const folderInput = document.getElementById("folderInput");
const uploadBtn = document.getElementById("uploadBtn");
const selectedFilesEl = document.getElementById("selectedFiles");
const uploadProgress = document.getElementById("uploadProgress");
const uploadProgressFill = document.getElementById("uploadProgressFill");
const uploadProgressText = document.getElementById("uploadProgressText");
const uploadProgressPercent = document.getElementById("uploadProgressPercent");
const uploadResult = document.getElementById("uploadResult");
const documentList = document.getElementById("documentList");
const expandedDocumentList = document.getElementById("expandedDocumentList");
const expandDocsBtn = document.getElementById("expandDocsBtn");
const docsModal = document.getElementById("docsModal");
const docsModalCount = document.getElementById("docsModalCount");
const closeDocsModalBtn = document.getElementById("closeDocsModalBtn");
const refreshDocsBtn = document.getElementById("refreshDocsBtn");
const dashboardEl = document.getElementById("dashboard");
const storageSummary = document.getElementById("storageSummary");
const chatWindow = document.getElementById("chatWindow");
const chatForm = document.getElementById("chatForm");
const questionInput = document.getElementById("questionInput");
const sendBtn = document.getElementById("sendBtn");
const chatLoading = document.getElementById("chatLoading");
const statusBadge = document.getElementById("statusBadge");
const filterFileType = document.getElementById("filterFileType");
const filterFolderPath = document.getElementById("filterFolderPath");
const themeToggleBtn = document.getElementById("themeToggleBtn");
const cancelChatBtn = document.getElementById("cancelChatBtn");
let docTypeChart = null;
let storageChart = null;
let indexHealthChart = null;
let activityChart = null;
let selectedFiles = [];
let latestDocuments = [];
let sessionId = localStorage.getItem("ragSessionId") || null;
let currentChatAbortController = null;
let chatCancelledByUser = false;
let currentSlide = 0;
const totalSlides = 4;
let slideInterval = null;
function applyTheme(theme) {
  const safeTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", safeTheme);
  localStorage.setItem("ragTheme", safeTheme);

  if (themeToggleBtn) {
    const nextLabel = safeTheme === "dark" ? "Light Mode" : "Dark Mode";
    themeToggleBtn.querySelector(".theme-toggle-text").textContent = nextLabel;
    themeToggleBtn.setAttribute("aria-label", `Switch to ${safeTheme === "dark" ? "light" : "dark"} theme`);
  }
}

function toggleTheme() {
  const active = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(active === "dark" ? "light" : "dark");
}

function setChatBusy(isBusy) {
  questionInput.disabled = isBusy;
  sendBtn.disabled = isBusy;
  if (cancelChatBtn) cancelChatBtn.classList.toggle("hidden", !isBusy);
}

applyTheme(localStorage.getItem("ragTheme") || "dark");
themeToggleBtn?.addEventListener("click", toggleTheme);
cancelChatBtn?.addEventListener("click", () => {
  if (!currentChatAbortController) return;
  chatCancelledByUser = true;
  currentChatAbortController.abort();
});

function setLoading(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
}

function setUploadProgress(percent, text) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
  uploadProgressFill.style.width = `${safePercent}%`;
  uploadProgressPercent.textContent = `${safePercent}%`;
  uploadProgressText.textContent = text;
}

function appendMessage(role, html) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = html;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return div;
}

function renderCitations(citations) {
  if (!citations?.length) return "";

  const items = citations
    .map((c) => {
      const page = c.pageNumber ? ` · page ${c.pageNumber}` : "";
      const ref = c.chunkRef ? ` · ref ${escapeHtml(c.chunkRef)}` : "";
      return `
      <li>
        <strong>${escapeHtml(c.fileName || c.source)}</strong>
        <span class="cite-meta">${escapeHtml(c.fileType || "")}${page} · chunk ${c.chunkIndex}${ref}</span>
        <p class="cite-excerpt">${escapeHtml(c.excerpt)}</p>
      </li>`;
    })
    .join("");

  return `<div class="citations"><h4>Sources</h4><ol>${items}</ol></div>`;
}

function renderStorageSummary(storage) {
  if (!storage) {
    storageSummary.textContent = "Vector DB: —";
    return;
  }

  const limit = storage.configuredLimitBytes;
  const freeText = storage.freeBytes === null ? "limit not set" : `${formatBytes(storage.freeBytes)} free`;
  const moreFiles = storage.approxMoreFiles === null ? "set VECTORSTORE_MAX_SIZE_MB for capacity" : `approx ${storage.approxMoreFiles} more max-size file(s)`;
  storageSummary.innerHTML = `
    <strong>Vector DB:</strong> ${formatBytes(storage.vectorStoreBytes)} used · ${freeText}<br>
    <span>Upload area: ${formatBytes(storage.uploadBytes)} · ${moreFiles} · Max ${storage.maxFilesPerUpload} files/upload</span>
    ${limit ? `<br><span>Configured limit: ${formatBytes(limit)}</span>` : ""}
  `;
}

function renderDashboard(data) {
  if (!data) {
    dashboardEl.innerHTML = '<p class="empty">Dashboard unavailable</p>';
    return;
  }

  renderStorageSummary(data.storage);
  dashboardEl.innerHTML = `
    <div class="dashboard-card"><span class="label">Files indexed</span><span class="value">${data.totalFilesIndexed ?? 0}</span></div>
    <div class="dashboard-card"><span class="label">Total chunks</span><span class="value">${data.totalChunks ?? 0}</span></div>
    <div class="dashboard-card"><span class="label">Vector count</span><span class="value">${data.vectorCount ?? 0}</span></div>
    <div class="dashboard-card"><span class="label">BM25 docs</span><span class="value">${data.bm25DocumentCount ?? 0}</span></div>
    <div class="dashboard-card"><span class="label">Vector DB size</span><span class="value">${formatBytes(data.storage?.vectorStoreBytes)}</span></div>
    <div class="dashboard-card"><span class="label">Free space</span><span class="value">${data.storage?.freeBytes === null ? "Limit not set" : formatBytes(data.storage?.freeBytes)}</span></div>
    <div class="dashboard-card"><span class="label">More files approx.</span><span class="value">${data.storage?.approxMoreFiles === null ? "—" : data.storage?.approxMoreFiles}</span></div>
    <div class="dashboard-card"><span class="label">Last indexed</span><span class="value">${formatDate(data.lastIndexingAt)}</span></div>
  `;
}

function mergeFileSelection(fileList, folderList) {
  const map = new Map();
  for (const file of [...fileList, ...folderList]) {
    map.set(file.webkitRelativePath || file.name, file);
  }
  selectedFiles = Array.from(map.values());
  updateSelectedFilesLabel();
}

function updateSelectedFilesLabel() {
  if (selectedFiles.length === 0) {
    selectedFilesEl.textContent = "";
    uploadBtn.disabled = true;
    return;
  }
  const preview = selectedFiles
    .slice(0, 5)
    .map((f) => f.webkitRelativePath || f.name)
    .join(", ");
  const more = selectedFiles.length > 5 ? ` … +${selectedFiles.length - 5} more` : "";
  const totalSize = selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
  selectedFilesEl.textContent = `${selectedFiles.length} file(s) selected · ${formatBytes(totalSize)}: ${preview}${more}`;
  uploadBtn.disabled = false;
}

function getDocFileKey(doc) {
  return encodeURIComponent(doc.fileKey || doc.filename || doc.name || "");
}

function renderDocumentItem(doc) {
  const rawKey = doc.fileKey || doc.filename || doc.name || "";
  const fileKey = encodeURIComponent(rawKey);
  const fileName = doc.filename || doc.name || doc.fileName || "Unknown file";

  const meta = [
    doc.fileType || doc.file_type || doc.type || doc.ext || "file",
    `v${doc.fileVersion ?? doc.version ?? 1}`,
    `${doc.chunkCount ?? doc.chunk_count ?? doc.chunks ?? 0} chunks`,
    `${formatBytes(doc.characterCount ?? doc.size ?? 0)} text`,
    formatDate(doc.uploadedAt ?? doc.uploaded_at ?? doc.updatedAt ?? doc.createdAt),
  ].filter(Boolean).join(" · ");

  return `
    <li class="doc-row">
      <div class="doc-item">
        <div class="doc-info">
          <span class="doc-name">${escapeHtml(fileName)}</span>
          <span class="doc-meta">${escapeHtml(meta)}</span>
          ${doc.folderPath ? `<span class="doc-path">${escapeHtml(doc.folderPath)}</span>` : ""}
        </div>
        <div class="doc-action-group">
          <button type="button" class="icon-doc-btn download-doc-btn" data-file-key="${fileKey}" title="Download" aria-label="Download ${escapeHtml(fileName)}"></button>
          <button type="button" class="icon-doc-btn delete-doc-btn" data-file-key="${fileKey}" title="Delete" aria-label="Delete ${escapeHtml(fileName)}"></button>
        </div>
      </div>
    </li>`;
}

function renderDocumentList(documents) {
  latestDocuments = Array.isArray(documents) ? documents : [];
  documentList.classList.add("compact-doc-list");
  expandedDocumentList.classList.remove("compact-doc-list");

  if (!latestDocuments.length) {
    documentList.innerHTML = '<li class="empty">No documents uploaded yet.</li>';
    expandedDocumentList.innerHTML = '<li class="empty">No documents uploaded yet.</li>';
    expandDocsBtn.classList.add("hidden");
    docsModalCount.textContent = "No uploaded/indexed files";
    return;
  }

  const compactDocs = latestDocuments.slice(0, 3);
  const hiddenCount = Math.max(0, latestDocuments.length - compactDocs.length);

  documentList.innerHTML = compactDocs.map(renderDocumentItem).join("")
    + (hiddenCount > 0
      ? `<li class="doc-expand-note"><button type="button" class="expand-inline-btn">+${hiddenCount} more file(s) · View all</button></li>`
      : "");

  expandedDocumentList.innerHTML = latestDocuments.map(renderDocumentItem).join("");
  docsModalCount.textContent = `${latestDocuments.length} file(s) indexed`;
  expandDocsBtn.classList.toggle("hidden", latestDocuments.length <= 3);
}

function openDocsModal() {
  if (!latestDocuments.length) return;
  expandedDocumentList.innerHTML = latestDocuments.map(renderDocumentItem).join("");
  docsModalCount.textContent = `${latestDocuments.length} file(s) indexed`;
  docsModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeDocsModal() {
  docsModal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function downloadDocument(fileKey) {
  if (!fileKey) {
    alert("File key missing");
    return;
  }
  window.location.href = `/api/documents/download/${fileKey}`;
}

window.downloadDocument = downloadDocument;
window.openDocsModal = openDocsModal;
window.closeDocsModal = closeDocsModal;

async function refreshStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error("Status check failed");
    const data = await res.json();

    statusBadge.textContent = data.indexed
      ? `${data.documentCount} document(s) indexed`
      : "No indexed documents";
    statusBadge.classList.toggle("ready", data.indexed);
    renderDocumentList(data.documents);
    if (data.dashboard) renderDashboard(data.dashboard);
  } catch {
    statusBadge.textContent = "Server unreachable";
    statusBadge.classList.remove("ready");
  }
}

async function refreshDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    if (res.ok) renderDashboard(await res.json());
  } catch {
    /* ignore */
  }
}

function uploadWithProgress(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        setUploadProgress(10, `Uploading ${selectedFiles.length} file(s)…`);
        return;
      }
      const percent = Math.round((event.loaded / event.total) * 100);
      const isComplete = event.loaded >= event.total;
      setUploadProgress(
        percent,
        isComplete
          ? `Uploaded ${formatBytes(event.loaded)} / ${formatBytes(event.total)}. Processing and indexing ${selectedFiles.length} file(s)…`
          : `Uploading ${formatBytes(event.loaded)} / ${formatBytes(event.total)} (${selectedFiles.length} file(s))…`
      );
    });

    xhr.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      reject(new Error(data.error || `Upload failed (${xhr.status})`));
    });

    xhr.addEventListener("error", () => reject(new Error("Upload failed. Server not reachable.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));

    setUploadProgress(1, `Starting upload for ${selectedFiles.length} file(s)…`);
    xhr.send(formData);
  });
}

fileInput.addEventListener("change", () => {
  mergeFileSelection(Array.from(fileInput.files || []), Array.from(folderInput.files || []));
});

folderInput.addEventListener("change", () => {
  mergeFileSelection(Array.from(fileInput.files || []), Array.from(folderInput.files || []));
});

refreshDocsBtn.addEventListener("click", refreshStatus);
expandDocsBtn.addEventListener("click", openDocsModal);
closeDocsModalBtn.addEventListener("click", closeDocsModal);
docsModal.addEventListener("click", (event) => {
  if (event.target === docsModal) closeDocsModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !docsModal.classList.contains("hidden")) closeDocsModal();
});

async function handleDocumentAction(event) {
  const expandButton = event.target.closest(".expand-inline-btn");
  if (expandButton) {
    openDocsModal();
    return;
  }

  const downloadButton = event.target.closest(".download-doc-btn");
  if (downloadButton) {
    downloadDocument(downloadButton.dataset.fileKey);
    return;
  }

  const button = event.target.closest(".delete-doc-btn");
  if (!button) return;

  const fileKey = button.dataset.fileKey;
  const name = button.closest("li")?.querySelector(".doc-name")?.textContent || "this file";
  if (!confirm(`Delete indexed file from Vector DB?

${name}

After delete, upload updated file again.`)) return;

  const previousHtml = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "…";

  try {
    const res = await fetch(`/api/documents/${fileKey}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Delete failed");
    uploadResult.classList.remove("hidden");
    uploadResult.className = "result-box success";
    uploadResult.innerHTML = `<strong>${escapeHtml(data.deletedFile)} deleted.</strong><br>${data.deletedChunks} vector chunk(s) removed. Now upload updated file.`;
    await refreshStatus();
    await refreshDashboard();
  } catch (err) {
    uploadResult.classList.remove("hidden");
    uploadResult.className = "result-box error";
    uploadResult.textContent = err.message;
    button.disabled = false;
    button.innerHTML = previousHtml;
  }
}
function goToSlide(index) {
  const slides = document.querySelectorAll('.carousel-slide');
  const dots = document.querySelectorAll('.dot-indicator');
  
  if (index < 0) index = totalSlides - 1;
  if (index >= totalSlides) index = 0;
  
  slides.forEach((slide, i) => {
    slide.classList.remove('active', 'exit');
    if (i === index) {
      slide.classList.add('active');
    } else {
      slide.classList.add('exit');
    }
  });
  
  dots.forEach((dot, i) => {
    dot.classList.toggle('active', i === index);
  });
  
  currentSlide = index;
}

function nextSlide() {
  goToSlide(currentSlide + 1);
  resetAutoPlay();
}

function prevSlide() {
  goToSlide(currentSlide - 1);
  resetAutoPlay();
}

function resetAutoPlay() {
  if (slideInterval) {
    clearInterval(slideInterval);
    slideInterval = null;
  }
  startAutoPlay();
}

function startAutoPlay() {
  if (slideInterval) clearInterval(slideInterval);
  slideInterval = setInterval(nextSlide, 5000);
}

// Initialize carousel
function initCarousel() {
  // Set initial slide
  goToSlide(0);
  
  // Event listeners for arrows
  const prevBtn = document.getElementById('prevChart');
  const nextBtn = document.getElementById('nextChart');
  const dots = document.querySelectorAll('.dot-indicator');
  
  if (prevBtn) prevBtn.addEventListener('click', prevSlide);
  if (nextBtn) nextBtn.addEventListener('click', nextSlide);
  
  dots.forEach((dot, index) => {
    dot.addEventListener('click', () => {
      goToSlide(index);
      resetAutoPlay();
    });
  });
  
  // Pause on hover
  const track = document.getElementById('chartCarousel');
  if (track) {
    track.addEventListener('mouseenter', () => {
      if (slideInterval) {
        clearInterval(slideInterval);
        slideInterval = null;
      }
    });
    track.addEventListener('mouseleave', startAutoPlay);
  }
  
  // Start auto-play
  startAutoPlay();
}

// Update charts when theme changes (update existing function)
function updateChartsTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#8a9bb5' : '#4a5a7a';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  
  const charts = [docTypeChart, storageChart, indexHealthChart, activityChart];
  charts.forEach(chart => {
    if (chart) {
      if (chart.options.plugins?.legend?.labels) {
        chart.options.plugins.legend.labels.color = textColor;
      }
      if (chart.options.scales?.y?.ticks) {
        chart.options.scales.y.ticks.color = textColor;
      }
      if (chart.options.scales?.x?.ticks) {
        chart.options.scales.x.ticks.color = textColor;
      }
      if (chart.options.scales?.y?.grid) {
        chart.options.scales.y.grid.color = gridColor;
      }
      chart.update();
    }
  });
}

// Modified initializeCharts - remove duplicate chart creation
function initializeCharts() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#8a9bb5' : '#4a5a7a';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  
  const colors = {
    blue: '#4d7cff',
    lightBlue: '#6b8fff',
    cyan: '#38bdf8',
    teal: '#22d3ee',
    green: '#34d399',
    yellow: '#fbbf24',
    pink: '#f472b6',
    purple: '#a78bfa'
  };

  // Destroy existing charts
  if (docTypeChart) { docTypeChart.destroy(); docTypeChart = null; }
  if (storageChart) { storageChart.destroy(); storageChart = null; }
  if (indexHealthChart) { indexHealthChart.destroy(); indexHealthChart = null; }
  if (activityChart) { activityChart.destroy(); activityChart = null; }

  // 1. Document Types Pie Chart
  const ctx1 = document.getElementById('docTypeChart')?.getContext('2d');
  if (ctx1) {
    docTypeChart = new Chart(ctx1, {
      type: 'doughnut',
      data: {
        labels: ['PDF', 'Word', 'Excel', 'Text', 'Images', 'Other'],
        datasets: [{
          data: [12, 5, 3, 8, 2, 4],
          backgroundColor: [
            colors.blue,
            colors.lightBlue,
            colors.cyan,
            colors.teal,
            colors.green,
            colors.yellow
          ],
          borderColor: isDark ? '#13161b' : '#eef1f5',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: textColor,
              font: { size: 11 },
              padding: 10,
              boxWidth: 12,
              boxHeight: 12,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          }
        },
        cutout: '65%'
      }
    });
  }

  // 2. Storage Bar Chart
  const ctx2 = document.getElementById('storageChart')?.getContext('2d');
  if (ctx2) {
    storageChart = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: ['Vector DB', 'Upload Area', 'Free Space'],
        datasets: [{
          label: 'Storage (MB)',
          data: [3.82, 118, 1020],
          backgroundColor: [
            colors.blue,
            colors.cyan,
            colors.green
          ],
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: gridColor
            },
            ticks: {
              color: textColor,
              font: { size: 10 }
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: textColor,
              font: { size: 10 }
            }
          }
        }
      }
    });
  }

  // 3. Index Health Doughnut Chart
  const ctx3 = document.getElementById('indexHealthChart')?.getContext('2d');
  if (ctx3) {
    indexHealthChart = new Chart(ctx3, {
      type: 'doughnut',
      data: {
        labels: ['Indexed', 'Processing', 'Failed', 'Pending'],
        datasets: [{
          data: [85, 8, 3, 4],
          backgroundColor: [
            colors.green,
            colors.yellow,
            colors.pink,
            colors.cyan
          ],
          borderColor: isDark ? '#13161b' : '#eef1f5',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: textColor,
              font: { size: 11 },
              padding: 10,
              boxWidth: 12,
              boxHeight: 12,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          }
        },
        cutout: '60%'
      }
    });
  }

  // 4. Activity Line Chart
  const ctx4 = document.getElementById('activityChart')?.getContext('2d');
  if (ctx4) {
    activityChart = new Chart(ctx4, {
      type: 'line',
      data: {
        labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        datasets: [
          {
            label: 'Queries',
            data: [12, 19, 15, 22, 28, 18, 10],
            borderColor: colors.blue,
            backgroundColor: `${colors.blue}20`,
            fill: true,
            tension: 0.4,
            pointBackgroundColor: colors.blue,
            pointBorderColor: isDark ? '#13161b' : '#eef1f5',
            pointBorderWidth: 2,
            pointRadius: 4
          },
          {
            label: 'Documents',
            data: [3, 5, 2, 7, 4, 1, 2],
            borderColor: colors.cyan,
            backgroundColor: `${colors.cyan}20`,
            fill: true,
            tension: 0.4,
            pointBackgroundColor: colors.cyan,
            pointBorderColor: isDark ? '#13161b' : '#eef1f5',
            pointBorderWidth: 2,
            pointRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: textColor,
              font: { size: 10 },
              padding: 8,
              boxWidth: 14,
              boxHeight: 14,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: gridColor
            },
            ticks: {
              color: textColor,
              font: { size: 10 }
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: textColor,
              font: { size: 10 }
            }
          }
        }
      }
    });
  }
}

// Update dashboard data with real values
function updateDashboardWithData(data) {
  if (!data) return;
  
  // Update metrics
  const docCount = document.getElementById('docCount');
  const chunkCount = document.getElementById('chunkCount');
  const vectorCount = document.getElementById('vectorCount');
  const storageCount = document.getElementById('storageCount');
  
  if (docCount) docCount.textContent = data.totalFilesIndexed ?? 0;
  if (chunkCount) chunkCount.textContent = data.totalChunks ?? 0;
  if (vectorCount) vectorCount.textContent = data.vectorCount ?? 0;
  if (storageCount) storageCount.textContent = formatBytes(data.storage?.vectorStoreBytes);
  
  // Update charts with real data
  if (docTypeChart && data.documentTypes) {
    docTypeChart.data.datasets[0].data = data.documentTypes.values || [12, 5, 3, 8, 2, 4];
    docTypeChart.update();
  }
  
  if (storageChart && data.storage) {
    storageChart.data.datasets[0].data = [
      data.storage.vectorStoreBytes / (1024 * 1024) || 3.82,
      data.storage.uploadBytes / (1024 * 1024) || 118,
      data.storage.freeBytes / (1024 * 1024) || 1020
    ];
    storageChart.update();
  }
  
  if (indexHealthChart && data.indexHealth) {
    indexHealthChart.data.datasets[0].data = data.indexHealth.values || [85, 8, 3, 4];
    indexHealthChart.update();
  }
  
  if (activityChart && data.activity) {
    activityChart.data.datasets[0].data = data.activity.queries || [12, 19, 15, 22, 28, 18, 10];
    activityChart.data.datasets[1].data = data.activity.documents || [3, 5, 2, 7, 4, 1, 2];
    activityChart.update();
  }
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize charts
  setTimeout(() => {
    initializeCharts();
    initCarousel();
  }, 100);
  
  // Theme toggle
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      setTimeout(() => {
        updateChartsTheme();
        // Re-render charts with new theme
        initializeCharts();
      }, 50);
    });
  }
});
documentList.addEventListener("click", handleDocumentAction);
expandedDocumentList.addEventListener("click", handleDocumentAction);

uploadBtn.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return;

  const formData = new FormData();
  selectedFiles.forEach((file) => {
    formData.append("attachments", file, file.webkitRelativePath || file.name);
  });

  uploadBtn.disabled = true;
  setLoading(uploadProgress, true);
  setUploadProgress(0, "Preparing files…");
  uploadResult.classList.add("hidden");

  try {
    const data = await uploadWithProgress(formData);
    setUploadProgress(100, "Upload and indexing complete.");

    uploadResult.classList.remove("hidden");
    uploadResult.className = "result-box success";

    const skippedNote =
      data.skipped?.length > 0
        ? `<p class="warn">${data.skipped.length} unchanged file(s) skipped (incremental indexing).</p>`
        : "";
    const errorNote =
      data.errors?.length > 0
        ? `<p class="warn">${data.errors.length} file(s) failed.</p>`
        : "";

    uploadResult.innerHTML = `
      <strong>${escapeHtml(data.message)}</strong>
      <ul>${(data.documents || [])
        .map(
          (d) =>
            `<li>${escapeHtml(d.filename)} (${escapeHtml(d.fileType)}, ${d.chunkCount} chunks)</li>`
        )
        .join("")}</ul>
      ${skippedNote}${errorNote}`;

    setUploadProgress(100, `Finished: indexed ${data.documents?.length ?? 0}, skipped ${data.skipped?.length ?? 0}, failed ${data.errors?.length ?? 0}.`);

    fileInput.value = "";
    folderInput.value = "";
    selectedFiles = [];
    updateSelectedFilesLabel();
    await refreshStatus();
    await refreshDashboard();

    appendMessage(
      "bot",
      `<p><strong>Upload complete.</strong> Indexed ${data.documents?.length ?? 0} new/updated file(s).</p>`
    );
  } catch (err) {
    uploadResult.classList.remove("hidden");
    uploadResult.className = "result-box error";
    uploadResult.textContent = err.message;
    setUploadProgress(0, "Upload failed.");
  } finally {
    setTimeout(() => setLoading(uploadProgress, false), 1200);
    uploadBtn.disabled = selectedFiles.length === 0;
  }
});


questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!sendBtn.disabled && questionInput.value.trim()) {
      chatForm.requestSubmit();
    }
  }
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", `<p>${escapeHtml(question)}</p>`);
  questionInput.value = "";
  chatCancelledByUser = false;
  currentChatAbortController = new AbortController();
  setChatBusy(true);
  setLoading(chatLoading, true);

  const botEl = appendMessage("bot", "<p></p>");
  const answerP = botEl.querySelector("p");
  let streamed = "";

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        sessionId,
        stream: true,
        fileType: filterFileType.value.trim() || null,
        folderPath: filterFolderPath.value.trim() || null,
      }),
      signal: currentChatAbortController.signal,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let citations = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6));

        if (payload.type === "token") {
          streamed += payload.token;
          answerP.innerHTML = escapeHtml(streamed).replace(/\n/g, "<br>");
          chatWindow.scrollTop = chatWindow.scrollHeight;
        }

        if (payload.type === "done") {
          sessionId = payload.sessionId;
          localStorage.setItem("ragSessionId", sessionId);
          citations = payload.citations || [];
          if (payload.answer) {
            streamed = payload.answer;
            answerP.innerHTML = escapeHtml(streamed).replace(/\n/g, "<br>");
          }
        }

        if (payload.type === "error") {
          throw new Error(payload.error);
        }
      }
    }

    // Source details are intentionally hidden in the chat UI.
    // Backend still keeps citations internally for logging/debugging.
    // botEl.insertAdjacentHTML("beforeend", renderCitations(citations));
  } catch (err) {
    if (chatCancelledByUser || err.name === "AbortError") {
      botEl.className = "message bot cancelled";
      answerP.innerHTML = "<strong>Request cancelled.</strong><br>The answer generation was stopped before completion.";
    } else {
      botEl.className = "message bot error";
      answerP.textContent = err.message;
    }
  } finally {
    currentChatAbortController = null;
    chatCancelledByUser = false;
    setChatBusy(false);
    setLoading(chatLoading, false);
    questionInput.focus();
  }
});

refreshStatus();
refreshDashboard();
setInterval(refreshStatus, 30000);
