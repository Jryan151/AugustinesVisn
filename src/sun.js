'use strict';
/* =====================================================================
   sun.js — sunrise and sunset for a place and a day, worked out locally (no weather or sun API to call).

   The standard sunrise equation (as used by NOAA's simpler calculator). Good to about a minute, which is plenty for
   setting session times. Longitude is east-positive, so Phoenix is -112.07.
   ===================================================================== */
const RAD = Math.PI / 180;
const J1970 = 2440587.5;
const J2000 = 2451545;

const toJulian = (ms) => ms / 86400000 + J1970;
const fromJulian = (j) => new Date(Math.round((j - J1970) * 86400000));

/**
 * Sunrise and sunset on a calendar day at (lat, lng). `ymd` is 'YYYY-MM-DD' (the local date).
 * Returns { sunrise: Date, sunset: Date } in real time (UTC inside), or null in polar day or night.
 */
function sunTimes(ymd, lat, lng) {
  const [y, m, d] = ymd.split('-').map(Number);
  // The day count is taken at local solar noon, so the transit found below falls on this local date.
  const jNoon = toJulian(Date.UTC(y, m - 1, d, 12));
  const n = Math.round(jNoon - J2000 - 0.0009 + lng / 360);
  const jStar = J2000 + 0.0009 - lng / 360 + n;
  const M = ((357.5291 + 0.98560028 * (jStar - J2000)) % 360 + 360) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  if (cosH < -1 || cosH > 1) return null;
  const h = Math.acos(cosH) / RAD / 360;
  return { sunrise: fromJulian(jTransit - h), sunset: fromJulian(jTransit + h) };
}

module.exports = { sunTimes };
