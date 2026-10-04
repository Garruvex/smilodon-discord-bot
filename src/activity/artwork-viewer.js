const viewer = () => document.querySelector("#artwork-viewer");
const viewerImage = () => document.querySelector("#artwork-viewer-image");
let temporaryUrl = null;
let opening = false;

async function openArtwork(image, title) {
  if (opening || viewer().open || image.hidden || !image.currentSrc) return;
  opening = true;
  const source = image.currentSrc;
  let displaySource = source;
  if (source.startsWith("blob:")) {
    try {
      const response = await fetch(source);
      displaySource = URL.createObjectURL(await response.blob());
      temporaryUrl = displaySource;
    } catch {
      // The original image remains usable if copying its in-memory URL fails.
    }
  }
  try {
    document.querySelector("#artwork-viewer-title").textContent = title;
    const fullImage = viewerImage();
    fullImage.src = displaySource;
    fullImage.alt = image.alt;
    viewer().showModal();
  } finally {
    opening = false;
  }
}

export function wireArtworkViewer() {
  const dialog = viewer();
  document.querySelector("#artwork-viewer-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => {
    viewerImage().removeAttribute("src");
    if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
    temporaryUrl = null;
  });
  document.querySelector("#scene-artwork-open").addEventListener("click", () => {
    void openArtwork(document.querySelector("#live-scene-image"), document.querySelector("#live-scene-title").textContent);
  });
  document.querySelector("#live-scene-image").addEventListener("click", () => {
    void openArtwork(document.querySelector("#live-scene-image"), document.querySelector("#live-scene-title").textContent);
  });
  document.querySelector("#hero-artwork-open").addEventListener("click", () => {
    void openArtwork(document.querySelector("#live-hero-image"), document.querySelector("#live-hero-name").textContent);
  });
  document.querySelector("#live-hero-image").addEventListener("click", () => {
    void openArtwork(document.querySelector("#live-hero-image"), document.querySelector("#live-hero-name").textContent);
  });
}
