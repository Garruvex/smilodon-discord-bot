import { DiscordSDK } from "@discord/embedded-app-sdk";

const detailDialog = document.querySelector("#detail-dialog");
const toast = document.querySelector(".toast");
let toastTimer;

function announce(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function openDetails(card = null) {
  const isOwnHero = card?.classList.contains("is-you") ?? true;
  document.querySelector("#detail-name").textContent = card?.dataset.hero ?? "Aria Vell";
  document.querySelector("#detail-subtitle").textContent = card?.dataset.subtitle ?? "High Elf Wizard 5";
  document.querySelector(".detail-dialog h3:first-of-type").hidden = !isOwnHero;
  document.querySelector(".detail-dialog h3:first-of-type + p").hidden = !isOwnHero;
  document.querySelector(".detail-dialog h3:last-of-type").hidden = !isOwnHero;
  document.querySelector(".detail-dialog h3:last-of-type + p").hidden = !isOwnHero;
  detailDialog.showModal();
}

function wirePreviewControls() {
  document.querySelectorAll(".party-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".party-card").forEach((item) => item.setAttribute("aria-pressed", String(item === card)));
      openDetails(card);
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "details") openDetails();
      else if (action === "history") announce("Discord history opens here after the Activity connects.");
      else if (action === "spell") announce("Spell previews will use the campaign rules after the game connection is added.");
      else announce("Game actions connect to the campaign engine in the next step.");
    });
  });
}

async function connectDiscord() {
  const response = await fetch("/activity-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the Discord application configuration.");
  const config = await response.json();
  const discordSdk = new DiscordSDK(config.applicationId);
  await discordSdk.ready();
  const previewNote = document.querySelector(".preview-note");
  previewNote.textContent = "UI preview with sample party. Discord connected.";
}

wirePreviewControls();
void connectDiscord().catch((error) => {
  console.info("Discord Activity handshake is unavailable in this browser preview.", error);
});
