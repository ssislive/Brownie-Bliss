/* =========================================================
   BROWNIE BLISS — LIVE DELIVERY TRACKING
   -----------------------------------------------------------
   This is a vanilla JS / static site, so there is no real
   backend pushing live GPS coordinates from a delivery partner.
   To make "live tracking" actually work without a server, this
   module SIMULATES a delivery partner moving along a real road
   route (fetched from OpenRouteService/OSRM — free, no API key
   for OSRM's public demo server) between the bakery and the
   customer, and drives the map + ETA + distance off that.

   Swap-in point for a real backend later:
   Replace `getDriverPosition()` with a fetch/WebSocket call to
   your live-location endpoint and everything else (map marker,
   ETA calc, distance calc, UI) keeps working unchanged — see
   the "REAL BACKEND HOOK" comment near the bottom.
========================================================= */

const BrownieTracking = (() => {

    // Bakery (origin) — Krishnagiri, Tamil Nadu (from footer address)
    const BAKERY_LOCATION = { lat: 12.5266, lng: 78.2150, label: "Brownie Bliss Kitchen" };

    // Average delivery scooter speed in km/h, used for ETA math
    const AVG_SPEED_KMPH = 28;

    // Simulated "tick" interval — how often the driver marker updates
    const TICK_MS = 3000;

    let map, driverMarker, bakeryMarker, homeMarker, routeLine;
    let routeCoords = [];      // [[lat,lng], ...] full path
    let routeCumDist = [];     // cumulative distance (km) at each route point
    let totalRouteKm = 0;
    let progressKm = 0;        // how far the driver has travelled so far
    let tickTimer = null;
    let statusCallback = null;

    /* ---------- distance helpers (Haversine, km) ---------- */
    function haversine(a, b) {
        const R = 6371;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const lat1 = a.lat * Math.PI / 180;
        const lat2 = b.lat * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.asin(Math.sqrt(h));
    }

    /* ---------- build a route ----------
       Tries a real road route via the public OSRM demo server.
       If that request fails (offline / blocked / rate-limited),
       falls back to a straight-line path split into steps so the
       feature still works with zero backend dependencies. */
    async function buildRoute(origin, dest) {
        try {
            const url = `https://router.project-osrm.org/route/v1/driving/` +
                `${origin.lng},${origin.lat};${dest.lng},${dest.lat}` +
                `?overview=full&geometries=geojson`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("OSRM request failed");
            const data = await res.json();
            const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
            return coords;
        } catch (err) {
            console.warn("Live route service unavailable, using straight-line fallback:", err);
            const steps = 40;
            const coords = [];
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                coords.push([
                    origin.lat + (dest.lat - origin.lat) * t,
                    origin.lng + (dest.lng - origin.lng) * t
                ]);
            }
            return coords;
        }
    }

    function computeCumulativeDistances(coords) {
        const cum = [0];
        for (let i = 1; i < coords.length; i++) {
            const a = { lat: coords[i - 1][0], lng: coords[i - 1][1] };
            const b = { lat: coords[i][0], lng: coords[i][1] };
            cum.push(cum[i - 1] + haversine(a, b));
        }
        return cum;
    }

    /* given distance travelled along the route, find lat/lng */
    function positionAtDistance(km) {
        if (km <= 0) return routeCoords[0];
        if (km >= totalRouteKm) return routeCoords[routeCoords.length - 1];
        for (let i = 1; i < routeCumDist.length; i++) {
            if (routeCumDist[i] >= km) {
                const segStart = routeCumDist[i - 1];
                const segEnd = routeCumDist[i];
                const segT = segEnd === segStart ? 0 : (km - segStart) / (segEnd - segStart);
                const a = routeCoords[i - 1];
                const b = routeCoords[i];
                return [
                    a[0] + (b[0] - a[0]) * segT,
                    a[1] + (b[1] - a[1]) * segT
                ];
            }
        }
        return routeCoords[routeCoords.length - 1];
    }

    /* ---------- geocode a rough customer location ----------
       Free-text -> approximate coords using OSM Nominatim.
       Falls back to a nearby randomized point around the bakery
       if geocoding isn't available, so the demo always works. */
    async function geocodeAddress(query) {
        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
            const res = await fetch(url, { headers: { "Accept-Language": "en" } });
            if (!res.ok) throw new Error("Nominatim request failed");
            const data = await res.json();
            if (data && data[0]) {
                return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
            }
            throw new Error("No geocode result");
        } catch (err) {
            console.warn("Geocoding unavailable, using a nearby fallback point:", err);
            const jitter = () => (Math.random() - 0.5) * 0.06; // ~ a few km
            return { lat: BAKERY_LOCATION.lat + jitter(), lng: BAKERY_LOCATION.lng + jitter() };
        }
    }

    function fmtKm(km) {
        return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
    }

    function fmtEta(minutes) {
        if (minutes < 1) return "Arriving now";
        if (minutes < 60) return `${Math.round(minutes)} min`;
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return `${h}h ${m}m`;
    }

    /* ---------- UI wiring ---------- */
    function updateInfoPanel(remainingKm) {
        const etaMinutes = (remainingKm / AVG_SPEED_KMPH) * 60;
        const distEl = document.getElementById("liveDistance");
        const etaEl = document.getElementById("liveEta");
        if (distEl) distEl.textContent = fmtKm(remainingKm);
        if (etaEl) etaEl.textContent = fmtEta(etaMinutes);

        const pct = Math.min(100, Math.round((progressKm / totalRouteKm) * 100));
        const fill = document.getElementById("liveProgressFill");
        if (fill) fill.style.width = `${pct}%`;

        updateStatusStage(pct);
    }

    function updateStatusStage(pct) {
        const stages = document.querySelectorAll(".live-stage");
        if (!stages.length) return;
        let activeIndex = 0;
        if (pct >= 100) activeIndex = 3;
        else if (pct >= 66) activeIndex = 2;
        else if (pct >= 15) activeIndex = 1;
        else activeIndex = 0;

        stages.forEach((el, i) => {
            el.classList.toggle("live-stage-done", i < activeIndex);
            el.classList.toggle("live-stage-active", i === activeIndex);
        });

        if (statusCallback) statusCallback(activeIndex);
    }

    /* ---------- REAL BACKEND HOOK ----------
       In simulation mode this just advances progressKm each tick.
       To go live: replace the body of this function with a fetch/
       WebSocket read of the driver's real {lat,lng}, then call
       `progressKm = distanceTravelledSoFarFromThatPoint(...)`
       (or skip progressKm entirely and pass the live point straight
       into `renderDriverAt(point)` + your own distance calc). */
    function getDriverPosition() {
        const speedKmPerTick = (AVG_SPEED_KMPH / 3600) * (TICK_MS / 1000);
        progressKm = Math.min(totalRouteKm, progressKm + speedKmPerTick);
        return positionAtDistance(progressKm);
    }

    function renderDriverAt(point) {
        if (!driverMarker) return;
        driverMarker.setLatLng(point);
        map.panTo(point, { animate: true });
    }

    function tick() {
        const point = getDriverPosition();
        renderDriverAt(point);
        const remainingKm = Math.max(0, totalRouteKm - progressKm);
        updateInfoPanel(remainingKm);

        if (progressKm >= totalRouteKm) {
            stop();
            const badge = document.getElementById("liveStatusBadge");
            if (badge) {
                badge.textContent = "Delivered";
                badge.classList.add("live-badge-delivered");
            }
        }
    }

    function stop() {
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = null;
    }

    /* ---------- public entry point ----------
       containerId: id of the div to mount the Leaflet map in
       customerQuery: free-text address / area to geocode
       onStageChange: optional callback(stageIndex) for custom UI hooks */
    async function start({ containerId, customerQuery, onStageChange }) {
        stop();
        statusCallback = onStageChange || null;
        progressKm = 0;

        const customer = await geocodeAddress(customerQuery || "Krishnagiri, Tamil Nadu");

        map = L.map(containerId, { zoomControl: true, attributionControl: true });

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap contributors"
        }).addTo(map);

        routeCoords = await buildRoute(BAKERY_LOCATION, customer);
        routeCumDist = computeCumulativeDistances(routeCoords);
        totalRouteKm = routeCumDist[routeCumDist.length - 1];

        routeLine = L.polyline(routeCoords, { color: "#d4a373", weight: 5, opacity: 0.85 }).addTo(map);
        map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });

        const bakeryIcon = L.divIcon({ className: "live-pin live-pin-bakery", html: "🥧", iconSize: [30, 30] });
        const homeIcon = L.divIcon({ className: "live-pin live-pin-home", html: "🏠", iconSize: [30, 30] });
        const driverIcon = L.divIcon({ className: "live-pin live-pin-driver", html: "🛵", iconSize: [34, 34] });

        bakeryMarker = L.marker(routeCoords[0], { icon: bakeryIcon }).addTo(map).bindTooltip("Brownie Bliss Kitchen");
        homeMarker = L.marker(routeCoords[routeCoords.length - 1], { icon: homeIcon }).addTo(map).bindTooltip("Delivery Address");
        driverMarker = L.marker(routeCoords[0], { icon: driverIcon }).addTo(map).bindTooltip("Your delivery partner");

        updateInfoPanel(totalRouteKm);
        tickTimer = setInterval(tick, TICK_MS);
    }

    return { start, stop };

})();
