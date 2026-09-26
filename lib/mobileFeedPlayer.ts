/**
 * The main phone feed keeps one media element for audible playback. WebKit's
 * autoplay grant belongs to the element, so replacing it for each post or
 * after a route change can ask for the same sound gesture again.
 *
 * This module owns only the element. Feed cards still own their presentation,
 * event listeners and muted neighbor previews. Desktop cards never call it.
 */
let player: HTMLVideoElement | null = null;
let parkingPlace: HTMLDivElement | null = null;
let owner: symbol | null = null;

function getParkingPlace(): HTMLDivElement {
  if (!parkingPlace || !parkingPlace.isConnected) {
    parkingPlace = document.createElement("div");
    parkingPlace.setAttribute("aria-hidden", "true");
    parkingPlace.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(parkingPlace);
  }
  return parkingPlace;
}

export function claimMobileFeedPlayer(host: HTMLElement, token: symbol, src: string): HTMLVideoElement {
  if (!player) {
    player = document.createElement("video");
    player.playsInline = true;
    player.loop = true;
  }
  if (owner !== token) player.pause();
  owner = token;
  host.appendChild(player);
  if (player.getAttribute("src") !== src) {
    player.src = src;
  }
  return player;
}

export function releaseMobileFeedPlayer(token: symbol): void {
  if (!player || owner !== token) return;
  player.pause();
  owner = null;
  getParkingPlace().appendChild(player);
}
