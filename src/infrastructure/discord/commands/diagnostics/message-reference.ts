export function messageInChannel(value: string, guildId: string, channelId: string): string | null {
  if (/^\d{17,20}$/u.test(value)) return value;
  const link = /^https:\/\/(?:(?:canary|ptb)\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/u.exec(value);
  return link && link[1] === guildId && link[2] === channelId ? link[3]! : null;
}
