(() => {
  'use strict';

  const STORAGE_KEY = 'drift-control-state-v1';
  const FORMATS = [8, 12, 16, 24, 32, 48, 64];
  // Developer-only sample tools. Set to true to expose the test roster and score generator.
  const ENABLE_TEST_TOOLS = false;
  // Developer-only sync setup help. Keep false for the public website.
  const ENABLE_SYNC_HELP = false;
  const TEST_DRIVERS = [
    ['Alex Mercer', 'Nissan Silvia S15'],
    ['Mia Kovacs', 'BMW E46'],
    ['Leo Novak', 'Toyota AE86'],
    ['Emma Varga', 'Nissan 350Z'],
    ['Noah Petrov', 'BMW E36'],
    ['Ava Jensen', 'Toyota Chaser JZX100'],
    ['Luka Weiss', 'BMW E92'],
    ['Sofia Markovic', 'Nissan Skyline R32'],
    ['Daniel Reed', 'Mazda RX-7 FD'],
    ['Isla Fischer', 'Nissan Silvia S13'],
    ['Oliver Berg', 'Lexus IS200'],
    ['Freya Hansen', 'BMW E30'],
    ['Ethan Cole', 'Toyota GT86'],
    ['Mila Ivanova', 'Nissan 370Z'],
    ['Mateo Silva', 'BMW M3 E46'],
    ['Lara Schmidt', 'Mazda MX-5'],
    ['Adam Zielinski', 'Toyota Supra MK4'],
    ['Nina Laurent', 'Nissan Skyline R34'],
    ['Finn Andersson', 'BMW E36 Compact'],
    ['Ella Rossi', 'Nissan 180SX'],
    ['Oscar Lind', 'Toyota Soarer'],
    ['Eva Horvat', 'Chevrolet Corvette C6'],
    ['Theo Martin', 'BMW E46 Coupe'],
    ['Lina Eriksson', 'Nissan Silvia S14'],
    ['Max Dubois', 'Toyota Mark II JZX90'],
    ['Aria Conti', 'Mazda RX-8'],
    ['Ben Taylor', 'BMW E92 M3'],
    ['Kira Sokolov', 'Nissan Laurel C35'],
    ['Hugo Meyer', 'Toyota Corolla AE86'],
    ['Zoe Campbell', 'Ford Mustang S197'],
    ['Jonas Klein', 'Nissan 350Z'],
    ['Sara Petrescu', 'BMW E36 Coupe']
  ].map(([name, car], index) => ({ name, car, index }));
  const DEFAULT_STATE = {
    eventName: 'DRIFT EVENT',
    format: 32,
    scoringMethod: 'best',
    drivers: [],
    bracket: null,
    backgroundUrl: '',
    backgroundName: '',
    tab: 'drivers'
  };

  const config = window.DRIFT_CONFIG || {};
  const cloudConfigured = Boolean(
    typeof config.supabaseUrl === 'string' && config.supabaseUrl.trim() &&
    typeof config.supabaseAnonKey === 'string' && config.supabaseAnonKey.trim()
  );
  let supabaseClient = null;
  let authSession = null;
  let cloudStatus = cloudConfigured ? 'connecting' : 'local';
  let isRemoteReady = false;
  let lastLocalWriteAt = 0;
  let state = loadLocalState();
  let renderQueued = false;
  let highlightedMatches = new Set();
  let highlightedWinnerMatch = '';
  let saveTimer = null;
  let remoteChannel = null;

  const root = document.getElementById('view-root');
  const modalRoot = document.getElementById('modal-root');
  const toastStack = document.getElementById('toast-stack');

  function uid() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const initial = structuredClone(DEFAULT_STATE);
        if (ENABLE_TEST_TOOLS) {
          initial.drivers = TEST_DRIVERS.map((sample) => ({
            id: `demo-${String(sample.index + 1).padStart(2, '0')}`,
            name: sample.name,
            car: sample.car,
            run1: null,
            run2: null,
            isDemo: true
          }));
        }
        return initial;
      }
      return normalizeState(JSON.parse(raw));
    } catch (_) {
      return structuredClone(DEFAULT_STATE);
    }
  }

  function normalizeState(input) {
    const base = { ...structuredClone(DEFAULT_STATE), ...(input || {}) };
    base.eventName = String(base.eventName || 'DRIFT EVENT').slice(0, 80);
    base.backgroundUrl = typeof base.backgroundUrl === 'string' ? base.backgroundUrl.slice(0, 2000000) : '';
    base.backgroundName = String(base.backgroundName || '').slice(0, 180);
    base.format = FORMATS.includes(Number(base.format)) ? Number(base.format) : 32;
    base.scoringMethod = base.scoringMethod === 'average' ? 'average' : 'best';
    base.tab = ['drivers', 'qualifying', 'bracket'].includes(base.tab) ? base.tab : 'drivers';
    const savedDrivers = Array.isArray(base.drivers) ? base.drivers : [];
    const removedTestDriverIds = new Set(!ENABLE_TEST_TOOLS
      ? savedDrivers.filter((driver) => driver.isDemo).map((driver) => String(driver.id || ''))
      : []);
    base.drivers = savedDrivers
      .filter((driver) => ENABLE_TEST_TOOLS || !driver.isDemo)
      .map((driver) => ({
        id: String(driver.id || uid()),
        name: String(driver.name || '').slice(0, 80),
        car: String(driver.car || '').slice(0, 100),
        run1: numberOrNull(driver.run1),
        run2: numberOrNull(driver.run2),
        isDemo: Boolean(driver.isDemo)
      }));
    if (base.bracket && Array.isArray(base.bracket.rounds)) {
      base.bracket = {
        size: Number(base.bracket.size) || 0,
        slotCount: Number(base.bracket.slotCount) || 0,
        format: Number(base.bracket.format) || base.format,
        scoringMethod: base.bracket.scoringMethod === 'average' ? 'average' : 'best',
        seededDriverIds: Array.isArray(base.bracket.seededDriverIds) ? base.bracket.seededDriverIds.map(String) : [],
        thirdPlace: base.bracket.thirdPlace && typeof base.bracket.thirdPlace === 'object' ? {
          id: String(base.bracket.thirdPlace.id || 'third-place'),
          round: -1,
          index: 0,
          a: base.bracket.thirdPlace.a ? String(base.bracket.thirdPlace.a) : null,
          b: base.bracket.thirdPlace.b ? String(base.bracket.thirdPlace.b) : null,
          winner: base.bracket.thirdPlace.winner ? String(base.bracket.thirdPlace.winner) : null,
          resolved: Boolean(base.bracket.thirdPlace.resolved),
          bye: false
        } : { id: 'third-place', round: -1, index: 0, a: null, b: null, winner: null, resolved: false, bye: false },
        rounds: base.bracket.rounds.map((round, ri) => Array.isArray(round) ? round.map((match, mi) => ({
          id: String(match.id || `r${ri}-m${mi}`),
          round: ri,
          index: mi,
          a: match.a ? String(match.a) : null,
          b: match.b ? String(match.b) : null,
          winner: match.winner ? String(match.winner) : null,
          resolved: Boolean(match.resolved),
          bye: Boolean(match.bye)
        })) : [])
      };
      if (!base.bracket.rounds.length || base.bracket.seededDriverIds.some((id) => removedTestDriverIds.has(id))) base.bracket = null;
      else refreshBracket(base.bracket);
    } else {
      base.bracket = null;
    }
    return base;
  }

  function persistLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* private browsing can block storage */ }
  }

  function canEdit() {
    return !cloudConfigured || Boolean(authSession && authSession.user);
  }

  function currentDriver(id) {
    return state.drivers.find((driver) => driver.id === id) || null;
  }

  function driverInitial(name) {
    const trimmed = String(name || '').trim();
    return trimmed ? trimmed.slice(0, 1).toUpperCase() : 'D';
  }

  function driverScore(driver, method = state.scoringMethod) {
    const one = numberOrNull(driver.run1);
    const two = numberOrNull(driver.run2);
    if (one === null && two === null) return null;
    if (one === null) return two;
    if (two === null) return one;
    return method === 'average' ? (one + two) / 2 : Math.max(one, two);
  }

  function formatScore(score) {
    if (score === null || score === undefined || !Number.isFinite(Number(score))) return '—';
    return Number(score).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  }

  function getRankedDrivers(method = state.scoringMethod) {
    return state.drivers
      .map((driver, index) => ({ driver, score: driverScore(driver, method), originalIndex: index }))
      .filter((entry) => entry.score !== null)
      .sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex));
  }

  function getSelectedDrivers() {
    return getRankedDrivers().slice(0, state.format).map((entry) => entry.driver);
  }

  function getWinnerOfFinal() {
    if (!state.bracket || !state.bracket.rounds.length) return null;
    const finalRound = state.bracket.rounds[state.bracket.rounds.length - 1];
    if (!finalRound || !finalRound.length) return null;
    const final = finalRound[0];
    return final && final.resolved && final.winner ? currentDriver(final.winner) : null;
  }

  function countResolvedMatches() {
    if (!state.bracket) return 0;
    const mainMatches = state.bracket.rounds.reduce((total, round) => total + round.filter((match) => match.resolved && match.a && match.b).length, 0);
    const third = state.bracket.thirdPlace;
    return mainMatches + (third && third.resolved && third.a && third.b ? 1 : 0);
  }

  function titleCaseRound(roundIndex, roundCount, bracket) {
    if (roundIndex === roundCount - 1) return 'BATTLE FOR 1ST & 2ND';
    if (roundIndex === 0 && bracket.size < bracket.slotCount) return `TOP ${bracket.size}`;
    const entries = Math.max(2, Math.round(bracket.slotCount / (2 ** roundIndex)));
    return `TOP ${entries}`;
  }

  function seedOrder(slotCount) {
    let seeds = [1, 2];
    while (seeds.length < slotCount) {
      const nextSize = seeds.length * 2;
      const next = [];
      for (const seed of seeds) next.push(seed, nextSize + 1 - seed);
      seeds = next;
    }
    return seeds;
  }

  function nextPowerOfTwo(value) {
    let count = 2;
    while (count < value) count *= 2;
    return count;
  }

  function makeBracket() {
    if (state.bracket && !window.confirm('Rebuild the bracket? This clears every recorded battle result. Driver entries and qualifying scores will stay.')) return false;
    const ranked = getRankedDrivers();
    const entrants = ranked.slice(0, state.format).map((item) => item.driver);
    if (entrants.length < 2) {
      showToast('Add at least two drivers with a qualifying score before building the bracket.', true);
      return false;
    }

    const slotCount = nextPowerOfTwo(entrants.length);
    const order = seedOrder(slotCount);
    const bySeed = new Map(entrants.map((driver, index) => [index + 1, driver.id]));
    const firstRound = [];
    for (let i = 0; i < slotCount; i += 2) {
      firstRound.push({
        id: `r0-m${i / 2}`,
        round: 0,
        index: i / 2,
        a: bySeed.get(order[i]) || null,
        b: bySeed.get(order[i + 1]) || null,
        winner: null,
        resolved: false,
        bye: false
      });
    }
    const rounds = [firstRound];
    let matchCount = firstRound.length;
    let roundNumber = 1;
    while (matchCount > 1) {
      matchCount = matchCount / 2;
      rounds.push(Array.from({ length: matchCount }, (_, index) => ({
        id: `r${roundNumber}-m${index}`,
        round: roundNumber,
        index,
        a: null,
        b: null,
        winner: null,
        resolved: false,
        bye: false
      })));
      roundNumber += 1;
    }
    state.bracket = {
      size: entrants.length,
      slotCount,
      format: state.format,
      scoringMethod: state.scoringMethod,
      seededDriverIds: entrants.map((driver) => driver.id),
      thirdPlace: { id: 'third-place', round: -1, index: 0, a: null, b: null, winner: null, resolved: false, bye: false },
      rounds
    };
    refreshBracket(state.bracket);
    state.tab = 'bracket';
    highlightedMatches = new Set();
    highlightedWinnerMatch = '';
    render();
    scheduleSave(true);
    showToast(`Bracket built — ${entrants.length} drivers seeded into a ${slotCount}-slot tree.`);
    return true;
  }

  function refreshBracket(bracket) {
    if (!bracket || !Array.isArray(bracket.rounds) || !bracket.rounds.length) return;
    const first = bracket.rounds[0];
    first.forEach((match) => {
      match.round = 0;
      const oldWinner = match.winner;
      if (match.a && match.b) {
        match.bye = false;
        if (oldWinner && (oldWinner === match.a || oldWinner === match.b) && match.resolved) {
          match.winner = oldWinner;
          match.resolved = true;
        } else {
          match.winner = null;
          match.resolved = false;
        }
      } else if (match.a || match.b) {
        match.winner = match.a || match.b;
        match.resolved = true;
        match.bye = true;
      } else {
        match.winner = null;
        match.resolved = true;
        match.bye = true;
      }
    });

    for (let roundIndex = 1; roundIndex < bracket.rounds.length; roundIndex += 1) {
      const previousRound = bracket.rounds[roundIndex - 1];
      const round = bracket.rounds[roundIndex];
      round.forEach((match, index) => {
        const parentA = previousRound[index * 2];
        const parentB = previousRound[index * 2 + 1];
        const nextA = parentA && parentA.winner ? parentA.winner : null;
        const nextB = parentB && parentB.winner ? parentB.winner : null;
        const changed = match.a !== nextA || match.b !== nextB;
        if (changed) {
          match.winner = null;
          match.resolved = false;
          match.bye = false;
        }
        match.a = nextA;
        match.b = nextB;
        match.round = roundIndex;
        match.index = index;

        const parentsResolved = Boolean(parentA && parentA.resolved && parentB && parentB.resolved);
        if (!parentsResolved) {
          if (match.winner && match.winner !== match.a && match.winner !== match.b) match.winner = null;
          match.resolved = false;
          match.bye = false;
          return;
        }
        if (match.a && match.b) {
          match.bye = false;
          if (match.winner && (match.winner === match.a || match.winner === match.b) && match.resolved && !changed) {
            match.resolved = true;
          } else {
            match.winner = null;
            match.resolved = false;
          }
        } else if (match.a || match.b) {
          match.winner = match.a || match.b;
          match.resolved = true;
          match.bye = true;
        } else {
          match.winner = null;
          match.resolved = true;
          match.bye = true;
        }
      });
    }
    refreshThirdPlace(bracket);
  }

  function refreshThirdPlace(bracket) {
    if (!bracket) return;
    if (!bracket.thirdPlace) {
      bracket.thirdPlace = { id: 'third-place', round: -1, index: 0, a: null, b: null, winner: null, resolved: false, bye: false };
    }
    const bronze = bracket.thirdPlace;
    const semifinalRound = bracket.rounds.length > 1 ? bracket.rounds[bracket.rounds.length - 2] : null;
    let nextA = null;
    let nextB = null;
    if (semifinalRound && semifinalRound.length === 2 && semifinalRound.every((match) => match.resolved && match.a && match.b && match.winner)) {
      const loserOf = (match) => match.winner === match.a ? match.b : match.a;
      nextA = loserOf(semifinalRound[0]);
      nextB = loserOf(semifinalRound[1]);
    }
    const changed = bronze.a !== nextA || bronze.b !== nextB;
    if (changed) {
      bronze.winner = null;
      bronze.resolved = false;
    }
    bronze.id = 'third-place';
    bronze.round = -1;
    bronze.index = 0;
    bronze.a = nextA;
    bronze.b = nextB;
    bronze.bye = false;
    if (!nextA || !nextB) {
      bronze.winner = null;
      bronze.resolved = false;
    } else if (bronze.resolved && (bronze.winner === nextA || bronze.winner === nextB)) {
      // Preserve a recorded bronze-battle winner while the semifinal losers stay the same.
    } else {
      bronze.winner = null;
      bronze.resolved = false;
    }
  }

  function matchIsReady(match) {
    return Boolean(match.a && match.b && !match.resolved);
  }

  function applyWinner(matchId, driverId) {
    if (!canEdit() || !state.bracket) return;
    let selectedMatch = null;
    let selectedRoundIndex = -1;
    let isThirdPlace = false;
    for (let r = 0; r < state.bracket.rounds.length; r += 1) {
      const match = state.bracket.rounds[r].find((item) => item.id === matchId);
      if (match) { selectedMatch = match; selectedRoundIndex = r; break; }
    }
    if (!selectedMatch && state.bracket.thirdPlace && state.bracket.thirdPlace.id === matchId) {
      selectedMatch = state.bracket.thirdPlace;
      isThirdPlace = true;
    }
    if (!selectedMatch || !selectedMatch.a || !selectedMatch.b) return;
    if (driverId !== selectedMatch.a && driverId !== selectedMatch.b) return;
    if (selectedMatch.winner === driverId && selectedMatch.resolved) return;

    const beforeSlots = new Map();
    state.bracket.rounds.forEach((round) => {
      round.forEach((match) => beforeSlots.set(match.id, `${match.a || ''}|${match.b || ''}|${match.winner || ''}|${match.resolved ? '1' : '0'}`));
    });
    if (state.bracket.thirdPlace) {
      const bronze = state.bracket.thirdPlace;
      beforeSlots.set(bronze.id, `${bronze.a || ''}|${bronze.b || ''}|${bronze.winner || ''}|${bronze.resolved ? '1' : '0'}`);
    }
    selectedMatch.winner = driverId;
    selectedMatch.resolved = true;
    selectedMatch.bye = false;
    refreshBracket(state.bracket);

    highlightedWinnerMatch = matchId;
    highlightedMatches = new Set();
    state.bracket.rounds.forEach((round, roundIndex) => {
      round.forEach((match) => {
        const after = `${match.a || ''}|${match.b || ''}|${match.winner || ''}|${match.resolved ? '1' : '0'}`;
        if (beforeSlots.get(match.id) !== after && roundIndex > selectedRoundIndex) highlightedMatches.add(match.id);
      });
    });
    if (state.bracket.thirdPlace) {
      const bronze = state.bracket.thirdPlace;
      const after = `${bronze.a || ''}|${bronze.b || ''}|${bronze.winner || ''}|${bronze.resolved ? '1' : '0'}`;
      if (beforeSlots.get(bronze.id) !== after && !isThirdPlace) highlightedMatches.add(bronze.id);
    }
    render();
    scheduleSave(true);
    const winner = currentDriver(driverId);
    if (isThirdPlace) {
      showToast(`${winner ? winner.name : 'Driver'} takes 3rd place!`);
    } else if (selectedRoundIndex === state.bracket.rounds.length - 1) {
      showToast(`${winner ? winner.name : 'Driver'} takes the championship!`);
    } else {
      showToast(`${winner ? winner.name : 'Driver'} advances to the next round.`);
    }
    window.setTimeout(() => {
      highlightedMatches = new Set();
      highlightedWinnerMatch = '';
      render();
    }, 800);
  }

  function setTab(tab) {
    if (!['drivers', 'qualifying', 'bracket'].includes(tab)) return;
    state.tab = tab;
    render();
    scheduleSave(false);
  }

  function setFormat(value) {
    const format = Number(value);
    if (!FORMATS.includes(format)) return;
    if (state.bracket && format !== state.format) {
      showToast('Reset the active bracket before changing its format.', true);
      render();
      return;
    }
    state.format = format;
    render();
    scheduleSave(false);
  }

  function addDriver(form) {
    if (!canEdit()) return;
    const data = new FormData(form);
    const name = String(data.get('driverName') || '').trim();
    const car = String(data.get('carChoice') || '').trim();
    if (!name) { showToast('Enter the driver’s name first.', true); return; }
    if (!car) { showToast('Add the driver’s car first.', true); return; }
    if (state.drivers.some((driver) => driver.name.trim().toLowerCase() === name.toLowerCase())) {
      showToast('A driver with that name is already on the roster.', true); return;
    }
    state.drivers.push({ id: uid(), name, car, run1: null, run2: null, isDemo: false });
    form.reset();
    render();
    scheduleSave(true);
    showToast(`${name} registered. Add their points in Qualifying.`);
  }

  function loadTestDrivers() {
    if (!ENABLE_TEST_TOOLS) return;
    if (!canEdit()) {
      showToast('Only event editors can add test drivers.', true);
      return;
    }
    if (state.bracket) {
      showToast('Reset the active bracket before adding drivers.', true);
      return;
    }

    const existingNames = new Set(state.drivers.map((driver) => driver.name.trim().toLowerCase()));
    let added = 0;
    TEST_DRIVERS.forEach((sample) => {
      if (existingNames.has(sample.name.toLowerCase())) return;
      state.drivers.push({
        id: uid(),
        name: sample.name,
        car: sample.car,
        run1: null,
        run2: null,
        isDemo: true
      });
      existingNames.add(sample.name.toLowerCase());
      added += 1;
    });

    if (!added) {
      showToast('The 32 test drivers are already on the roster.');
      return;
    }
    state.tab = 'drivers';
    render();
    scheduleSave(true);
    showToast(`Added ${added} test drivers. Their points are blank — enter Run 1 and Run 2 in Qualifying.`);
  }

  function fillTestPoints() {
    if (!ENABLE_TEST_TOOLS) return;
    if (!canEdit()) {
      showToast('Only event editors can edit qualifying points.', true);
      return;
    }
    if (state.bracket) {
      showToast('Reset the active bracket before changing qualifying points.', true);
      return;
    }

    const demos = state.drivers.filter((driver) => driver.isDemo);
    if (!demos.length) {
      showToast('Load the test drivers first.', true);
      return;
    }
    demos.forEach((driver, index) => {
      driver.run1 = Number((58 + ((index * 13) % 41) + ((index % 4) * 0.2)).toFixed(1));
      driver.run2 = Number((56 + ((index * 17 + 5) % 43) + ((index % 3) * 0.3)).toFixed(1));
    });
    state.tab = 'qualifying';
    render();
    scheduleSave(true);
    showToast(`Added sample Run 1 and Run 2 points to ${demos.length} test drivers. You can edit every score.`);
  }

  function updateDriverField(driverId, field, value) {
    if (!canEdit()) return;
    const driver = currentDriver(driverId);
    if (!driver) return;
    if (field === 'run1' || field === 'run2') {
      const number = numberOrNull(value);
      if (number !== null && number < 0) { showToast('Qualifying scores must be zero or higher.', true); render(); return; }
      driver[field] = number;
    } else if (field === 'name') {
      const name = String(value || '').trim().slice(0, 80);
      if (!name) { showToast('Driver name cannot be empty.', true); render(); return; }
      if (state.drivers.some((other) => other.id !== driverId && other.name.trim().toLowerCase() === name.toLowerCase())) {
        showToast('Driver names must be unique.', true); render(); return;
      }
      driver.name = name;
    } else if (field === 'car') {
      const car = String(value || '').trim().slice(0, 100);
      if (!car) { showToast('Car or chassis cannot be empty.', true); render(); return; }
      driver.car = car;
    } else {
      return;
    }
    if (state.bracket && (field === 'name' || field === 'car')) {
      // Bracket slots reference the driver ID; name and car update live without reseeding.
    }
    render();
    scheduleSave(false);
  }

  function removeDriver(driverId) {
    if (!canEdit()) return;
    const driver = currentDriver(driverId);
    if (!driver) return;
    if (state.bracket && state.bracket.seededDriverIds.includes(driverId)) {
      showToast('This driver is in the active bracket. Reset and rebuild the bracket before removing them.', true);
      return;
    }
    state.drivers = state.drivers.filter((item) => item.id !== driverId);
    render();
    scheduleSave(true);
    showToast(`${driver.name} removed from the roster.`);
  }

  function saveEventSettings(form) {
    if (!canEdit()) return;
    const data = new FormData(form);
    const name = String(data.get('eventName') || '').trim().slice(0, 80);
    const format = Number(data.get('format'));
    const scoring = String(data.get('scoringMethod') || 'best') === 'average' ? 'average' : 'best';
    const backgroundInput = String(data.get('backgroundUrl') || '').trim();
    if (!name) { showToast('Event name cannot be empty.', true); return; }
    if (!FORMATS.includes(format)) { showToast('Choose a valid bracket format.', true); return; }
    if (state.bracket && (format !== state.format || scoring !== state.scoringMethod)) {
      showToast('Reset the current bracket before changing its format or scoring rule.', true);
      return;
    }
    let parsedBackground = null;
    if (backgroundInput) {
      try { parsedBackground = new URL(backgroundInput); } catch (_) { showToast('Enter a valid image URL starting with http:// or https://.', true); return; }
      if (!['http:', 'https:'].includes(parsedBackground.protocol)) { showToast('Background URLs must use http:// or https://.', true); return; }
    }
    state.eventName = name;
    state.format = format;
    state.scoringMethod = scoring;
    if (parsedBackground) {
      state.backgroundUrl = parsedBackground.href;
      state.backgroundName = parsedBackground.hostname;
    }
    applyPageBackground();
    modalRoot.innerHTML = '';
    render();
    scheduleSave(true);
    showToast('Event settings saved.');
  }

  function applyPageBackground() {
    const backdrop = document.getElementById('page-backdrop');
    if (!backdrop) return;
    if (state.backgroundUrl) {
      const safeUrl = state.backgroundUrl.replace(/\\/g, '%5C').replace(/"/g, '%22');
      backdrop.style.backgroundImage = `url("${safeUrl}")`;
      backdrop.classList.add('has-photo');
    } else {
      backdrop.style.backgroundImage = '';
      backdrop.classList.remove('has-photo');
    }
  }

  function loadImageAsCompressedBlob(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const scale = Math.min(1, 1920 / image.width, 1200 / image.height);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            URL.revokeObjectURL(objectUrl);
            if (blob) resolve(blob);
            else reject(new Error('Could not process that image. Try a JPG, PNG or WebP file.'));
          }, 'image/webp', 0.78);
        } catch (error) {
          URL.revokeObjectURL(objectUrl);
          reject(error);
        }
      };
      image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('This image could not be opened.')); };
      image.src = objectUrl;
    });
  }

  function blobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not save the image in this browser.'));
      reader.readAsDataURL(blob);
    });
  }

  async function handleBackgroundFile(file) {
    if (!file) return;
    if (!canEdit()) { showToast('Sign in as an editor to change the event background.', true); return; }
    if (!file.type.startsWith('image/')) { showToast('Choose an image file.', true); return; }
    if (file.size > 12 * 1024 * 1024) { showToast('Please choose an image smaller than 12 MB.', true); return; }
    showToast('Preparing background image…');
    try {
      const blob = await loadImageAsCompressedBlob(file);
      if (cloudConfigured) {
        if (!supabaseClient || !authSession || !authSession.user) throw new Error('Sign in as an editor to upload a shared background.');
        const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp';
        const safeName = `${Date.now()}-${String(file.name || 'background').replace(/[^a-zA-Z0-9._-]/g, '-').slice(-90)}.${extension}`;
        const { data, error } = await supabaseClient.storage.from('drift-backgrounds').upload(safeName, blob, {
          cacheControl: '3600', upsert: false, contentType: blob.type || 'image/webp'
        });
        if (error) throw new Error(error.message || 'Upload failed. Make sure storage rules from schema.sql are installed.');
        const result = supabaseClient.storage.from('drift-backgrounds').getPublicUrl(data.path);
        state.backgroundUrl = result.data.publicUrl;
      } else {
        state.backgroundUrl = await blobAsDataUrl(blob);
      }
      state.backgroundName = String(file.name || 'Custom background').slice(0, 180);
      applyPageBackground();
      render();
      scheduleSave(true);
      modalRoot.innerHTML = '';
      showToast('Background updated. It will be visible to event viewers when live sync is enabled.');
    } catch (error) {
      showToast(`Could not upload background: ${error.message || 'unknown error'}`, true);
    }
  }

  function resetBracket() {
    if (!canEdit()) return;
    if (state.bracket && !window.confirm('Reset the bracket and clear every battle result? Driver entries and qualifying scores will stay.')) return;
    state.bracket = null;
    highlightedMatches = new Set();
    highlightedWinnerMatch = '';
    render();
    scheduleSave(true);
    showToast('Bracket cleared. Qualifying scores are unchanged.');
  }

  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    toastStack.appendChild(toast);
    window.setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(5px)';
      window.setTimeout(() => toast.remove(), 240);
    }, 3400);
  }

  function scheduleSave(announceError = false) {
    if (!cloudConfigured) {
      persistLocal();
      return;
    }
    if (!canEdit() || !isRemoteReady) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveRemote(announceError), 250);
  }

  async function saveRemote(announceError = false) {
    if (!supabaseClient || !canEdit() || !isRemoteReady) return;
    const snapshot = JSON.parse(JSON.stringify(state));
    const { error } = await supabaseClient
      .from('drift_events')
      .update({ state: snapshot, updated_at: new Date().toISOString() })
      .eq('id', 'main');
    if (error) {
      cloudStatus = 'error';
      updateConnectionStatus();
      if (announceError) showToast(`Could not sync changes: ${error.message}`, true);
      return;
    }
    lastLocalWriteAt = Date.now();
    cloudStatus = 'live';
    updateConnectionStatus();
  }

  async function loadRemoteState() {
    if (!supabaseClient) return;
    cloudStatus = 'connecting';
    updateConnectionStatus();
    const { data, error } = await supabaseClient.from('drift_events').select('state').eq('id', 'main').maybeSingle();
    if (error) {
      cloudStatus = 'error';
      isRemoteReady = false;
      updateConnectionStatus();
      showToast('Live sync could not load. Check config.js and schema.sql.', true);
      return;
    }
    if (data && data.state) {
      state = normalizeState(data.state);
    } else {
      // The supplied SQL creates this row. This fallback supports a project where it was removed.
      state = loadLocalState();
      if (authSession && authSession.user) {
        const { error: insertError } = await supabaseClient.from('drift_events').insert({ id: 'main', state });
        if (insertError) {
          showToast(`Could not initialize the shared event: ${insertError.message}`, true);
        }
      }
    }
    isRemoteReady = true;
    cloudStatus = 'live';
    render();
    updateConnectionStatus();
  }

  function updateConnectionStatus() {
    const indicator = document.getElementById('sync-indicator');
    const label = document.getElementById('sync-label');
    const navLabel = document.getElementById('nav-live-label');
    if (!indicator || !label || !navLabel) return;
    indicator.classList.remove('live', 'error');
    if (!cloudConfigured) {
      label.textContent = 'LOCAL PREVIEW';
      navLabel.textContent = 'LOCAL DATA';
    } else if (cloudStatus === 'live') {
      indicator.classList.add('live');
      label.textContent = 'LIVE SYNC';
      navLabel.textContent = 'REAL-TIME DATA';
    } else if (cloudStatus === 'error') {
      indicator.classList.add('error');
      label.textContent = 'SYNC ERROR';
      navLabel.textContent = 'CHECK CONNECTION';
    } else {
      label.textContent = 'CONNECTING';
      navLabel.textContent = 'CONNECTING';
    }
  }

  function renderAuthArea() {
    const area = document.getElementById('auth-area');
    if (!area) return;
    if (!cloudConfigured) {
      // Do not expose setup instructions on the public site unless explicitly enabled.
      area.innerHTML = ENABLE_SYNC_HELP
        ? '<button class="auth-button" type="button" data-action="sync-help">SYNC SETUP ↗</button>'
        : '';
      return;
    }
    if (authSession && authSession.user) {
      const email = escapeHtml(authSession.user.email || 'EDITOR');
      area.innerHTML = `<button class="auth-button primary" type="button" data-action="logout" title="Signed in as ${email}">EDITOR MODE ✓</button>`;
    } else {
      area.innerHTML = '<button class="auth-button" type="button" data-action="login">EDITOR LOGIN ↗</button>';
    }
  }

  function renderStats() {
    const ranked = getRankedDrivers();
    const champion = getWinnerOfFinal();
    document.getElementById('event-name-display').textContent = state.eventName;
    document.getElementById('stat-drivers').textContent = String(state.drivers.length).padStart(2, '0');
    document.getElementById('stat-battles').textContent = String(countResolvedMatches());
    document.getElementById('stat-format').textContent = `TOP ${state.format}`;
    document.getElementById('stat-champion').textContent = champion ? champion.name : '—';
    document.querySelectorAll('.nav-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === state.tab);
    });
    updateConnectionStatus();
    renderAuthArea();
  }

  function render() {
    renderStats();
    applyPageBackground();
    if (state.tab === 'bracket') root.innerHTML = renderBracketView();
    else if (state.tab === 'qualifying') root.innerHTML = renderQualifyingView();
    else root.innerHTML = renderDriversView();
    attachNoListenersNeeded();
  }

  function attachNoListenersNeeded() {
    // Event delegation keeps interactions stable as the panels re-render.
  }

  function renderDriversView() {
    const editors = canEdit();
    const count = state.drivers.length;
    const entries = state.drivers.map((driver, index) => {
      const bracketLock = state.bracket && state.bracket.seededDriverIds.includes(driver.id);
      const lockedAttr = editors ? '' : ' disabled';
      return `<article class="driver-entry">
        <span class="driver-avatar">${escapeHtml(driverInitial(driver.name))}</span>
        <label class="driver-field"><small>Driver name</small><input class="table-input" aria-label="Driver name" data-driver-id="${escapeHtml(driver.id)}" data-field="name" value="${escapeHtml(driver.name)}"${lockedAttr}></label>
        <label class="driver-field"><small>Car of choice</small><input class="table-input" aria-label="Car of choice" data-driver-id="${escapeHtml(driver.id)}" data-field="car" value="${escapeHtml(driver.car)}"${lockedAttr}></label>
        <div class="entry-actions"><span class="entry-number">${String(index + 1).padStart(2, '0')}</span>${editors ? `<button class="row-action" type="button" data-action="remove-driver" data-driver-id="${escapeHtml(driver.id)}" title="Remove driver"${bracketLock ? ' disabled' : ''}>${bracketLock ? 'IN BRACKET' : 'REMOVE ×'}</button>` : '<span class="status-chip">VIEW ONLY</span>'}</div>
      </article>`;
    }).join('');

    return `
      <div class="view-heading">
        <div><h2>Drivers</h2><p>Add every driver and car to build your grid. Points are entered separately in Qualifying.</p></div>
        <div class="heading-actions"><span class="status-chip">${count} registered</span>${editors && ENABLE_TEST_TOOLS ? '<button class="button" type="button" data-action="load-test-drivers"' + (state.bracket ? ' disabled title="Reset the bracket before adding drivers"' : '') + '>＋ Load 32 test drivers</button>' : ''}</div>
      </div>
      ${editors ? `<section class="controls-panel">
        <div class="controls-head"><div class="controls-title">Register driver</div></div>
        <form class="controls-body" id="add-driver-form">
          <div class="field"><label for="driver-name">Driver name</label><input id="driver-name" name="driverName" required maxlength="80" placeholder="e.g. Alex K." autocomplete="off"></div>
          <div class="field"><label for="car-choice">Car of choice</label><input id="car-choice" name="carChoice" required maxlength="100" placeholder="e.g. BMW E46" autocomplete="off"></div>
          <button class="button acid controls-submit" type="submit">＋ Register driver</button>
        </form>
      </section>` : `<div class="readonly-note"><span>VIEW MODE</span> — only event editors can register or edit drivers.</div>`}
      <section class="panel">
        <div class="panel-heading"><div><h3>Entry list</h3></div><span class="panel-tag">${count} drivers</span></div>
        ${count ? `<div class="driver-list">${entries}</div>` : `<div class="empty-table"><div class="empty-symbol">01</div><strong>No drivers registered yet</strong><p>Start by adding the first driver and their car. You can add qualifying points once the roster is ready.</p>${editors ? '<button class="button acid" type="button" data-action="focus-add">＋ Register first driver</button>' : '<span class="status-chip">WAITING FOR EVENT EDITOR</span>'}</div>`}
        ${state.bracket ? '<div class="readonly-note"><span>BRACKET ACTIVE</span> — reset the bracket before removing a seeded driver.</div>' : ''}
      </section>`;
  }

  function renderQualifyingView() {
    const editors = canEdit();
    const ranked = getRankedDrivers();
    const selectedIds = new Set(ranked.slice(0, state.format).map((entry) => entry.driver.id));
    const rankMap = new Map(ranked.map((entry, index) => [entry.driver.id, index + 1]));
    const sortedDrivers = [...state.drivers].sort((a, b) => {
      const ar = rankMap.has(a.id) ? rankMap.get(a.id) : Number.POSITIVE_INFINITY;
      const br = rankMap.has(b.id) ? rankMap.get(b.id) : Number.POSITIVE_INFINITY;
      return ar - br || state.drivers.indexOf(a) - state.drivers.indexOf(b);
    });
    const rowMarkup = sortedDrivers.map((driver) => {
      const rank = rankMap.get(driver.id);
      const scored = rank !== undefined;
      const onCut = scored && selectedIds.has(driver.id);
      const status = !scored ? '<span class="status-chip">AWAITING POINTS</span>' : onCut
        ? `<span class="status-chip good">IN TOP ${state.format}</span>`
        : '<span class="status-chip out">OUTSIDE CUT</span>';
      const lockedAttr = editors ? '' : ' disabled';
      const bracketLock = state.bracket && state.bracket.seededDriverIds.includes(driver.id);
      return `<tr class="${scored && !onCut ? 'is-cut' : ''}">
        <td><span class="seed-number ${onCut ? 'seed-qualifier' : ''}">${rank ? String(rank).padStart(2, '0') : '—'}</span></td>
        <td><div class="driver-cell"><span class="driver-avatar">${escapeHtml(driverInitial(driver.name))}</span><div><strong>${escapeHtml(driver.name)}</strong></div></div></td>
        <td>${escapeHtml(driver.car || '—')}</td>
        <td><input class="table-input" aria-label="${escapeHtml(driver.name)} Run 1 points" type="number" min="0" step="0.1" placeholder="—" data-driver-id="${escapeHtml(driver.id)}" data-field="run1" value="${driver.run1 === null ? '' : escapeHtml(driver.run1)}"${lockedAttr}></td>
        <td><input class="table-input" aria-label="${escapeHtml(driver.name)} Run 2 points" type="number" min="0" step="0.1" placeholder="—" data-driver-id="${escapeHtml(driver.id)}" data-field="run2" value="${driver.run2 === null ? '' : escapeHtml(driver.run2)}"${lockedAttr}></td>
        <td><span class="${scored ? 'score-best' : 'muted-score'}">${formatScore(driverScore(driver))}</span></td>
        <td>${status}</td>
      </tr>`;
    }).join('');
    const scoredCount = ranked.length;

    return `
      <div class="view-heading">
        <div><h2>Qualifying points</h2><p>Enter each driver’s Run 1 and Run 2 here, after the entry list is ready.</p></div>
        <div class="heading-actions">${ENABLE_TEST_TOOLS && editors && state.drivers.some((driver) => driver.isDemo) ? '<button class="button" type="button" data-action="fill-test-points"' + (state.bracket ? ' disabled title="Reset the bracket before changing qualifying points"' : '') + '>Fill test points</button>' : ''}<button class="button" type="button" data-action="export-csv">↓ Export CSV</button><button class="button acid" type="button" data-action="build-bracket"${editors ? '' : ' disabled'}>${state.bracket ? 'Rebuild bracket' : 'Build bracket →'}</button></div>
      </div>
      <div class="qual-toolbar">
        <span class="toolbar-label">BRACKET FORMAT</span>
        <select id="format-select" class="inline-select" data-action="format-select" aria-label="Bracket format"${editors && !state.bracket ? '' : ' disabled'}>${FORMATS.map((format) => `<option value="${format}"${state.format === format ? ' selected' : ''}>Top ${format}</option>`).join('')}</select>
        <span class="toolbar-label">SCORING</span>
        <select id="scoring-select" class="inline-select" data-action="scoring-select" aria-label="Qualifying scoring rule"${editors && !state.bracket ? '' : ' disabled'}><option value="best"${state.scoringMethod === 'best' ? ' selected' : ''}>Best run</option><option value="average"${state.scoringMethod === 'average' ? ' selected' : ''}>Average</option></select>
        <span class="toolbar-spacer"></span>
        <span class="panel-tag">${scoredCount} SCORED / ${state.drivers.length} REGISTERED</span>
      </div>
      <section class="panel">
        <div class="panel-heading"><div><h3>Run results</h3><p>${state.scoringMethod === 'best' ? 'Best of Run 1 and Run 2' : 'Average of entered runs'} · higher points rank first.</p></div><span class="panel-tag">TOP ${state.format} CUT</span></div>
        <div class="table-meta"><span><strong>${state.drivers.length}</strong> registered drivers</span><span>Enter points here — driver details stay in Drivers</span></div>
        ${sortedDrivers.length ? `<div class="table-scroll"><table class="roster-table"><thead><tr><th>RANK</th><th>DRIVER</th><th>CAR</th><th>RUN 1 POINTS</th><th>RUN 2 POINTS</th><th>QUAL SCORE</th><th>STATUS</th></tr></thead><tbody>${rowMarkup}</tbody></table></div>` : `<div class="empty-table"><div class="empty-symbol">02</div><strong>Register drivers first</strong><p>Your driver list is empty. Add drivers in the first step, then come back here to enter their qualifying points.</p><button class="button acid" type="button" data-action="tab" data-tab="drivers">Go to Drivers →</button></div>`}
        ${state.bracket ? '<div class="readonly-note"><span>BRACKET SEEDED</span> — score edits do not automatically reseed active battles. Reset and rebuild the bracket to apply updated qualifying results.</div>' : ''}
      </section>`;
  }

  function renderMatch(match, roundIndex, roundMarker = null) {
    const a = currentDriver(match.a);
    const b = currentDriver(match.b);
    const ready = matchIsReady(match);
    const isWinnerPop = match.id === highlightedWinnerMatch;
    const extraClass = `${ready ? ' match-ready' : ''}${match.resolved ? ' match-resolved' : ''}${highlightedMatches.has(match.id) ? ' advance-in' : ''}${isWinnerPop ? ' winner-pop' : ''}`;
    let statusText = 'WAITING';
    let statusClass = '';
    if (match.bye) { statusText = 'BYE'; statusClass = 'bye'; }
    else if (match.resolved && match.a && match.b) { statusText = 'DECIDED'; }
    else if (ready) { statusText = 'READY'; statusClass = 'ready'; }
    else if (a || b) { statusText = 'ADVANCING'; }
    const driverRow = (driver, slot) => {
      if (!driver) {
        let emptyLabel = match.bye ? 'BYE / NO OPPONENT' : 'Awaiting driver';
        if (!match.bye && match.resolved && !match.a && !match.b) emptyLabel = 'No qualifier';
        return `<div class="battle-driver ghost"><span class="battle-seed">—</span><span class="battle-name">${emptyLabel}</span><span class="win-indicator">·</span></div>`;
      }
      const isWinner = match.winner === driver.id && match.resolved;
      const isInteractive = canEdit() && match.a && match.b;
      const disabled = isInteractive ? '' : ' disabled';
      return `<button class="battle-driver ${isWinner ? 'winner' : ''}" type="button" data-action="select-winner" data-match-id="${escapeHtml(match.id)}" data-driver-id="${escapeHtml(driver.id)}"${disabled} aria-label="Select ${escapeHtml(driver.name)} as the winner">` +
        `<span class="battle-seed">${slot === 'a' ? 'A' : 'B'}</span><span class="battle-name-wrap"><span class="battle-name">${escapeHtml(driver.name)}</span><span class="battle-car">${escapeHtml(driver.car || 'CAR NOT SET')}</span></span><span class="win-indicator">✓</span></button>`;
    };
    const roundLabel = roundMarker || String(roundIndex + 1).padStart(2, '0');
    return `<article class="match-card${extraClass}" data-match-card="${escapeHtml(match.id)}">
      <div class="match-meta"><span>M${String(match.index + 1).padStart(2, '0')} · ${escapeHtml(roundLabel)}</span><span class="match-status ${statusClass}">${statusText}</span></div>
      ${driverRow(a, 'a')}${driverRow(b, 'b')}
      <div class="match-foot">${match.resolved && match.winner ? 'WINNER ADVANCED' : ready ? (canEdit() ? 'SELECT THE BATTLE WINNER' : 'AWAITING JUDGES') : match.bye ? 'AUTOMATIC ADVANCE' : 'BRACKET PROGRESSION'}</div>
    </article>`;
  }

  function renderBracketView() {
    const editors = canEdit();
    const bracket = state.bracket;
    const scored = getRankedDrivers().length;
    const selector = `<div class="field-inline"><label for="bracket-format-select">FORMAT</label><select id="bracket-format-select" class="inline-select" data-action="format-select"${editors && !bracket ? '' : ' disabled'}>${FORMATS.map((format) => `<option value="${format}"${state.format === format ? ' selected' : ''}>TOP ${format}</option>`).join('')}</select></div>`;
    const toolbar = `<div class="bracket-toolbar"><div class="bracket-toolbar-left">${selector}<span class="bracket-summary">${scored} SCORED · <strong>${Math.min(scored, state.format)} IN THE CUT</strong></span></div><div class="bracket-toolbar-right">${bracket ? `<button class="button" type="button" data-action="go-qualifying">← QUALIFYING</button><button class="button danger" type="button" data-action="reset-bracket"${editors ? '' : ' disabled'}>RESET BRACKET</button>` : `<button class="button" type="button" data-action="go-qualifying">← QUALIFYING SCORES</button><button class="button acid" type="button" data-action="build-bracket"${editors ? '' : ' disabled'}><span class="button-icon">↗</span> GENERATE BRACKET</button>`}</div></div>`;
    if (!bracket) {
      return `<div class="view-heading"><div><h2>Bracket</h2><p>Generate the bracket from qualifying scores, then select each battle winner to advance.</p></div></div>${toolbar}<section class="bracket-wrap"><div class="bracket-empty"><div class="bracket-empty-symbol">↗</div><h3>NO BRACKET DEPLOYED.</h3><p>Enter qualifying scores and lock the grid to seed your ${state.format}-driver format. The bracket handles byes, round progression and the championship match.</p>${editors ? '<button class="button acid" type="button" data-action="go-qualifying">OPEN QUALIFYING ↗</button>' : '<span class="status-chip">WAITING FOR EVENT EDITOR</span>'}</div></section>`;
    }
    const finalRoundIndex = bracket.rounds.length - 1;
    const earlierRoundsMarkup = bracket.rounds.slice(0, -1).map((round, index) => {
      const label = titleCaseRound(index, bracket.rounds.length, bracket);
      const resolvedCount = round.filter((match) => match.resolved && match.a && match.b).length;
      const possibleCount = round.filter((match) => match.a && match.b).length;
      return `<div class="round-column" data-round="${index}"><div class="round-head"><div><h4>${escapeHtml(label)}</h4><small>STAGE ${String(index + 1).padStart(2, '0')}</small></div><span class="round-count">${resolvedCount}/${possibleCount}</span></div><div class="round-matches">${round.map((match) => renderMatch(match, index)).join('')}</div></div>`;
    }).join('');
    const finalRound = bracket.rounds[finalRoundIndex] || [];
    const finalResolved = finalRound.filter((match) => match.resolved && match.a && match.b).length;
    const finalPossible = finalRound.filter((match) => match.a && match.b).length;
    const finalMarkup = `<div class="round-column" data-round="${finalRoundIndex}"><div class="round-head"><div><h4>${escapeHtml(titleCaseRound(finalRoundIndex, bracket.rounds.length, bracket))}</h4><small>CHAMPIONSHIP</small></div><span class="round-count">${finalResolved}/${finalPossible}</span></div><div class="round-matches">${finalRound.map((match) => renderMatch(match, finalRoundIndex, 'FINAL')).join('')}</div></div>`;
    const bronze = bracket.thirdPlace || { id: 'third-place', index: 0, a: null, b: null, winner: null, resolved: false, bye: false };
    const bronzeReady = Boolean(bronze.a && bronze.b);
    const bronzeColumn = bracket.rounds.length > 1 && bracket.size >= 4 ? `<div class="round-column placement-column" data-round="third-place"><div class="round-head"><div><h4>BATTLE FOR 3RD</h4><small>BRONZE BATTLE</small></div><span class="round-count">${bronze.resolved && bronzeReady ? '1' : '0'}/${bronzeReady ? '1' : '0'}</span></div><div class="round-matches">${renderMatch(bronze, -1, '3RD')}</div></div>` : '';
    const roundsMarkup = earlierRoundsMarkup + bronzeColumn + finalMarkup;
    const champion = getWinnerOfFinal();
    const championshipBanner = champion ? `<section class="champion-banner"><div><div class="champion-kicker">★ &nbsp; EVENT CHAMPION CONFIRMED</div><div class="champion-name">${escapeHtml(champion.name)}</div><div class="champion-car">${escapeHtml(champion.car)} <span style="color:var(--acid);margin-left:7px">· ${escapeHtml(state.eventName)}</span></div></div><div class="champion-trophy">★</div></section>` : '';
    const placed = bracket.size;
    const summaryText = `${placed} drivers · ${bracket.slotCount}-slot bracket · ${countResolvedMatches()} decided battles`;
    return `
      <div class="view-heading"><div><div class="section-kicker">STAGE 02 / ELIMINATION</div><h2>THE ROAD TO THE FINAL</h2><p>Choose a winning driver in any ready match. Their name advances automatically; changing an earlier result clears dependent battles.</p></div><div class="heading-actions"><span class="status-chip good"><span class="live-pip"></span>&nbsp; BRACKET ACTIVE</span></div></div>
      ${toolbar}
      <section class="bracket-wrap">
        <div class="bracket-topline"><div><h3>${escapeHtml(state.eventName)} / ELIMINATION TREE</h3><p>${escapeHtml(summaryText)} · Qualifying seeding locked at generation</p></div><div class="bracket-top-meta">FORMAT: TOP ${bracket.format}<br>SCORING: ${bracket.scoringMethod === 'best' ? 'BEST RUN' : 'AVERAGE'}</div></div>
        <div class="bracket-scroll"><div class="bracket-board">${roundsMarkup}</div></div>
        <div class="bracket-legend"><span class="legend-item"><span class="legend-box ready"></span> READY TO JUDGE</span><span class="legend-item"><span class="legend-box won"></span> WINNER ADVANCED</span><span class="legend-item"><span class="legend-box"></span> WAITING / BYE</span><span style="margin-left:auto">${editors ? 'CLICK A DRIVER TO RECORD THE WINNER' : 'VIEW-ONLY · RESULTS UPDATE LIVE'}</span></div>
      </section>
      ${championshipBanner}`;
  }

  function openSettingsModal() {
    const editors = canEdit();
    const formatLocked = Boolean(state.bracket);
    const imageStatus = state.backgroundUrl ? `Current background: ${escapeHtml(state.backgroundName || 'custom image')}` : 'No custom background selected.';
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal-background">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="modal-head"><div><h3 id="settings-title">Event settings</h3><p>Update event details, bracket rules and the background image used by spectators.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>
          <form class="modal-body" id="event-settings-form">
            <div class="field"><label for="event-name-input">Event name</label><input id="event-name-input" class="settings-input" name="eventName" maxlength="80" value="${escapeHtml(state.eventName)}" required${editors ? '' : ' disabled'}></div>
            <div class="modal-grid">
              <div class="field"><label for="settings-format">Bracket format</label><select id="settings-format" class="settings-input" name="format"${editors && !formatLocked ? '' : ' disabled'}>${FORMATS.map((format) => `<option value="${format}"${state.format === format ? ' selected' : ''}>Top ${format}</option>`).join('')}</select></div>
              <div class="field"><label for="settings-scoring">Qualifying rule</label><select id="settings-scoring" class="settings-input" name="scoringMethod"${editors && !formatLocked ? '' : ' disabled'}><option value="best"${state.scoringMethod === 'best' ? ' selected' : ''}>Best run</option><option value="average"${state.scoringMethod === 'average' ? ' selected' : ''}>Average</option></select></div>
            </div>
            ${formatLocked ? '<p class="modal-note">Reset the active bracket before changing format or scoring.</p>' : ''}
            <div class="settings-divider"></div>
            <div class="field"><label for="background-url">Background image URL</label><input id="background-url" class="settings-input" name="backgroundUrl" type="url" placeholder="https://example.com/drift-photo.jpg"${editors ? '' : ' disabled'}><div class="current-background">${imageStatus}</div></div>
            <div class="field"><label for="background-file">Or upload a background image</label><input id="background-file" name="backgroundFile" type="file" accept="image/*"${editors ? '' : ' disabled'}><small class="modal-note">Images are resized for the web. With Supabase connected, uploads are shared with everyone; demo mode keeps them in this browser.</small></div>
            <div id="settings-error" class="modal-error" hidden></div>
            <div class="modal-actions">${state.backgroundUrl && editors ? '<button class="button danger" type="button" data-action="clear-background">Remove background</button>' : ''}<button class="button" type="button" data-action="close-modal">Cancel</button><button class="button acid" type="submit"${editors ? '' : ' disabled'}>Save settings</button></div>
            ${!editors ? '<p class="modal-note">Sign in as an editor to change event settings.</p>' : ''}
          </form>
        </section>
      </div>`;
  }

  function openLoginModal() {
    if (!cloudConfigured) { openSyncHelp(); return; }
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal-background">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
          <div class="modal-head"><div><h3 id="login-title">EDITOR ACCESS</h3><p>Sign in to manage the live qualifying grid and record battle results.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>
          <form class="modal-body" id="login-form">
            <div class="field"><label for="login-email">EMAIL</label><input id="login-email" name="email" type="email" required autocomplete="username" placeholder="editor@example.com"></div>
            <div class="field"><label for="login-password">PASSWORD</label><input id="login-password" name="password" type="password" required autocomplete="current-password" placeholder="Your editor password"></div>
            <div id="login-error" class="modal-error" hidden></div>
            <div class="modal-actions"><button class="button" type="button" data-action="close-modal">CANCEL</button><button class="button acid" type="submit">SIGN IN ↗</button></div>
            <p class="modal-note">Editor accounts are created by the event owner in Supabase. Public visitors can watch the bracket without signing in.</p>
          </form>
        </section>
      </div>`;
  }

  function openSyncHelp() {
    if (!ENABLE_SYNC_HELP) return;
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal-background">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="sync-help-title">
          <div class="modal-head"><div><h3 id="sync-help-title">ENABLE LIVE SYNC</h3><p>GitHub Pages serves the website; Supabase stores event data and broadcasts updates.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div>
          <div class="modal-body"><p class="modal-note">The site is currently using local demo mode, so changes only exist in this browser. To share live changes with other viewers:</p><ol style="padding-left:19px;color:var(--muted);font-size:10px;line-height:1.9"><li>Create a Supabase project and run <strong>schema.sql</strong> (including background image storage policies).</li><li>Paste your project URL and publishable/anon key into <strong>config.js</strong>.</li><li>Deploy these files to GitHub Pages and create an editor account in Supabase.</li></ol><div class="modal-actions"><button class="button acid" type="button" data-action="close-modal">GOT IT</button></div></div>
        </section>
      </div>`;
  }

  async function login(form) {
    if (!supabaseClient) return;
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    const password = String(data.get('password') || '');
    const button = form.querySelector('button[type="submit"]');
    const errorElement = document.getElementById('login-error');
    button.disabled = true;
    button.textContent = 'SIGNING IN…';
    errorElement.hidden = true;
    const { data: result, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    button.disabled = false;
    button.textContent = 'SIGN IN ↗';
    if (error) {
      errorElement.textContent = error.message || 'Sign in failed.';
      errorElement.hidden = false;
      return;
    }
    authSession = result.session;
    modalRoot.innerHTML = '';
    await loadRemoteState();
    render();
    showToast('Editor access granted. Changes now sync live.');
  }

  async function logout() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    authSession = null;
    render();
    showToast('Signed out. The bracket remains visible in viewer mode.');
  }

  function exportCsv() {
    const ranked = getRankedDrivers();
    const rows = [['Rank', 'Driver', 'Car', 'Run 1', 'Run 2', 'Qualifying Score', 'Status']];
    const rankMap = new Map(ranked.map((item, index) => [item.driver.id, index + 1]));
    [...state.drivers].sort((a, b) => {
      const ar = rankMap.get(a.id) || Number.POSITIVE_INFINITY;
      const br = rankMap.get(b.id) || Number.POSITIVE_INFINITY;
      return ar - br;
    }).forEach((driver) => {
      const rank = rankMap.get(driver.id) || '';
      const qualified = rank && rank <= state.format;
      rows.push([rank, driver.name, driver.car, driver.run1 ?? '', driver.run2 ?? '', driverScore(driver) ?? '', !rank ? 'NO SCORE' : qualified ? 'QUALIFIED' : 'OUTSIDE CUT']);
    });
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(state.eventName || 'drift-event').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-qualifying.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) {
      if (event.target.classList.contains('modal-backdrop')) modalRoot.innerHTML = '';
      return;
    }
    const action = button.dataset.action;
    if (action === 'tab') setTab(button.dataset.tab);
    else if (action === 'open-settings') openSettingsModal();
    else if (action === 'clear-background') {
      if (!canEdit()) return;
      state.backgroundUrl = '';
      state.backgroundName = '';
      applyPageBackground();
      render();
      scheduleSave(true);
      modalRoot.innerHTML = '';
      showToast('Background removed.');
    }
    else if (action === 'build-bracket') makeBracket();
    else if (action === 'select-winner') applyWinner(button.dataset.matchId, button.dataset.driverId);
    else if (action === 'remove-driver') removeDriver(button.dataset.driverId);
    else if (action === 'load-test-drivers' && ENABLE_TEST_TOOLS) loadTestDrivers();
    else if (action === 'fill-test-points' && ENABLE_TEST_TOOLS) fillTestPoints();
    else if (action === 'reset-bracket') resetBracket();
    else if (action === 'go-qualifying') setTab('qualifying');
    else if (action === 'login') openLoginModal();
    else if (action === 'logout') logout();
    else if (action === 'sync-help' && ENABLE_SYNC_HELP) openSyncHelp();
    else if (action === 'close-modal') modalRoot.innerHTML = '';
    else if (action === 'focus-add') {
      const input = document.getElementById('driver-name');
      if (input) input.focus();
    } else if (action === 'export-csv') exportCsv();
    else if (action === 'close-modal-background' && event.target === button) modalRoot.innerHTML = '';
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('[data-driver-id][data-field]')) {
      updateDriverField(target.dataset.driverId, target.dataset.field, target.value);
    } else if (target.matches('[data-action="format-select"]')) {
      if (!canEdit()) return;
      setFormat(target.value);
    } else if (target.matches('[data-action="scoring-select"]')) {
      if (!canEdit()) return;
      if (state.bracket) { showToast('Reset the active bracket before changing scoring.', true); render(); return; }
      state.scoringMethod = target.value === 'average' ? 'average' : 'best';
      render();
      scheduleSave(false);
    } else if (target.id === 'background-file') {
      handleBackgroundFile(target.files && target.files[0]);
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form.id === 'add-driver-form') {
      event.preventDefault();
      addDriver(form);
    } else if (form.id === 'event-settings-form') {
      event.preventDefault();
      saveEventSettings(form);
    } else if (form.id === 'login-form') {
      event.preventDefault();
      login(form);
    }
  });

  async function initializeCloud() {
    if (!cloudConfigured) {
      render();
      updateConnectionStatus();
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      cloudStatus = 'error';
      render();
      updateConnectionStatus();
      showToast('Supabase client did not load. Check your network connection.', true);
      return;
    }
    try {
      supabaseClient = window.supabase.createClient(config.supabaseUrl.trim(), config.supabaseAnonKey.trim());
      const { data } = await supabaseClient.auth.getSession();
      authSession = data ? data.session : null;
      await loadRemoteState();
      const { data: subscription } = supabaseClient.auth.onAuthStateChange((_event, session) => {
        authSession = session;
        render();
      });
      // Hold the subscription object to keep the listener referenced during this page's lifetime.
      window.__driftAuthSubscription = subscription;
      remoteChannel = supabaseClient.channel('drift-event-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'drift_events', filter: 'id=eq.main' }, (payload) => {
          if (Date.now() - lastLocalWriteAt < 1100) return;
          if (payload.new && payload.new.state) {
            state = normalizeState(payload.new.state);
            isRemoteReady = true;
            cloudStatus = 'live';
            render();
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            cloudStatus = 'live';
            updateConnectionStatus();
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            cloudStatus = 'error';
            updateConnectionStatus();
          }
        });
      window.__driftRemoteChannel = remoteChannel;
      render();
    } catch (error) {
      cloudStatus = 'error';
      render();
      updateConnectionStatus();
      showToast(`Live sync setup failed: ${error.message || 'unknown error'}`, true);
    }
  }

  // Normalize the sample/current browser state as soon as the app loads.
  state = normalizeState(state);

  // Developer test mode should be useful even after the browser has already
  // saved an empty state on a previous visit. Never seed over a real roster,
  // and do not seed the shared/cloud event automatically.
  if (ENABLE_TEST_TOOLS && !cloudConfigured && state.drivers.length === 0) {
    state.drivers = TEST_DRIVERS.map((sample) => ({
      id: `demo-${String(sample.index + 1).padStart(2, '0')}`,
      name: sample.name,
      car: sample.car,
      run1: null,
      run2: null,
      isDemo: true
    }));
    persistLocal();
  }

  applyPageBackground();
  render();
  initializeCloud();
})();
