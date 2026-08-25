import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { GuildMember } from "discord.js";

import { extractAvatarPalette } from "../canvas/avatar-palette.js";
import { fontFamily } from "../canvas/card-font.js";

const width = 1000;
const height = 500;
const avatarRadius = 100;
const avatarCenterX = width / 2;
const avatarCenterY = 185;

export async function renderWelcomeCard(member: GuildMember): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0A0910";
  ctx.fillRect(0, 0, width, height);

  const avatarUrl = member.user.displayAvatarURL({ extension: "png", size: 256 });
  let colorA = "#B98CFF";
  let colorB = "#7CC6FF";
  let avatarImage: Awaited<ReturnType<typeof loadImage>> | null = null;
  try {
    const avatarBuffer = Buffer.from(await (await fetch(avatarUrl)).arrayBuffer());
    avatarImage = await loadImage(avatarBuffer);
    [colorA, colorB] = extractAvatarPalette(avatarImage);
  } catch {
    // Falls back to the fixed palette and a plain circle below.
  }

  // Glow stays tight around the avatar (fades out well before the subtitle
  // line) instead of washing the whole card — a big bright radial gradient
  // behind body text kills contrast.
  const glow = ctx.createRadialGradient(
    avatarCenterX, avatarCenterY, avatarRadius * 0.4,
    avatarCenterX, avatarCenterY, avatarRadius * 2.3,
  );
  glow.addColorStop(0, `${colorA}55`);
  glow.addColorStop(1, `${colorA}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(
    avatarCenterX - avatarRadius * 2.3, avatarCenterY - avatarRadius * 2.3,
    avatarRadius * 4.6, avatarRadius * 4.6,
  );

  const ring = ctx.createLinearGradient(
    avatarCenterX - avatarRadius, avatarCenterY - avatarRadius,
    avatarCenterX + avatarRadius, avatarCenterY + avatarRadius,
  );
  ring.addColorStop(0, colorA);
  ring.addColorStop(1, colorB);
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarRadius + 7, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();

  if (avatarImage) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(
      avatarImage,
      avatarCenterX - avatarRadius, avatarCenterY - avatarRadius,
      avatarRadius * 2, avatarRadius * 2,
    );
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#2A2830";
    ctx.fill();
  }

  const displayName = member.displayName;
  ctx.textAlign = "center";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold 44px "${fontFamily}"`;
  ctx.fillText(`Welcome, ${displayName}!`, avatarCenterX, 345);

  ctx.fillStyle = "#A9A6B8";
  ctx.font = `23px "${fontFamily}"`;
  ctx.fillText(`Glad you found ${member.guild.name}`, avatarCenterX, 382);

  const pillText = `Member #${member.guild.memberCount}`;
  ctx.font = `600 19px "${fontFamily}"`;
  const pillWidth = ctx.measureText(pillText).width + 44;
  const pillX = avatarCenterX - pillWidth / 2;
  const pillY = 415;
  const pillHeight = 40;
  const pillRadius = pillHeight / 2;
  ctx.beginPath();
  ctx.moveTo(pillX + pillRadius, pillY);
  ctx.arcTo(pillX + pillWidth, pillY, pillX + pillWidth, pillY + pillHeight, pillRadius);
  ctx.arcTo(pillX + pillWidth, pillY + pillHeight, pillX, pillY + pillHeight, pillRadius);
  ctx.arcTo(pillX, pillY + pillHeight, pillX, pillY, pillRadius);
  ctx.arcTo(pillX, pillY, pillX + pillWidth, pillY, pillRadius);
  ctx.closePath();
  const pillGradient = ctx.createLinearGradient(pillX, 0, pillX + pillWidth, 0);
  pillGradient.addColorStop(0, `${colorA}40`);
  pillGradient.addColorStop(1, `${colorB}40`);
  ctx.fillStyle = pillGradient;
  ctx.fill();
  ctx.fillStyle = "#F1EEF7";
  ctx.font = `600 19px "${fontFamily}"`;
  ctx.fillText(pillText, avatarCenterX, pillY + 26);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}
