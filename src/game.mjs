/* global electron */

import os from 'node:os';
import net from 'node:net';
import storage from './storage.mjs';
import * as rpc from './rpc.mjs';
import sudo from 'sudo-prompt';
import cap from 'cap';
import ZwiftPacketMonitor from '@saucellc/zwift-packet-monitor';
import sauce from '../shared/sauce/index.mjs';
import fetch from 'node-fetch';
import {getAppSetting} from './main.mjs';

const athleteCacheLabel = 'athlete-cache';


async function getAthleteCache() {
    const data = await storage.load(athleteCacheLabel);
    return new Map(data || undefined);
}


let _saveAthleteTimeout;
let _saveAthleteData;
function queueSaveAthleteCache(data) {
    _saveAthleteData = data;
    if (!_saveAthleteTimeout) {
        _saveAthleteTimeout = setTimeout(async () => {
            _saveAthleteTimeout = null;
            if (!_saveAthleteData) {
                return;
            }
            const saving = Array.from(_saveAthleteData);
            _saveAthleteData = null;
            await storage.save(athleteCacheLabel, saving);
        }, 5000);
    }
}


async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}


const worldTimeOffset = 1414016074335;  // ms since zwift started production.
function worldTimeConv(wt) {
    // TBD I think timesync helps us adjust the offset but I can't interpret it yet.
    return new Date(Number(worldTimeOffset) + Number(wt));
}


function highPrecTimeConv(ts) {
    // As seen on payload timestamps.
    const dv = new DataView(new Uint32Array([ts.low, ts.high]).buffer);
    const ns = dv.getBigUint64(0, /*le*/ true);
    return +`${ns / 1000n}.${ns % 1000n}`; // Lossless conv to ms
}


function headingConv(microRads) {
    const halfCircle = 1000000 * Math.PI;
    return (((microRads + halfCircle) / (2 * halfCircle)) * 360) % 360;
}


function crowDistance(a, b) {
    return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2) / 100;  // roughly meters
}


function estGap(a, b, dist) {
    dist = dist !== undefined ? dist : crowDistance(a, b);
    return dist / ((a.speed || b.speed || 1) * 1000 / 3600);
}


class RollingPeaks {
    constructor(Klass, periods, options={}) {
        const defOptions = {idealGap: 0.200, maxGap: 10, active: true};
        this._firstTS = null;
        this.roll = new Klass(null, {...defOptions, ...options});
        this.periodized = new Map(periods.map(period => [period, {
            roll: this.roll.clone({period}),
            peak: null,
        }]));
        this.max = 0;
    }

    add(ts, value) {
        // XXX Perhaps we should have a aggregation buffer here so
        // we don't accumulate a bunch of repetitive data.
        if (this._firstTS === null) {
            this._firstTS = ts;
        }
        const time = (ts - this._firstTS) / 1000;
        this.roll.add(time, value);
        if (value > this.max) {
            this.max = value;
        }
        for (const x of this.periodized.values()) {
            x.roll.resize();
            if (x.roll.full()) {
                const avg = x.roll.avg();
                if (x.peak === null || avg >= x.peak.avg()) {
                    x.peak = x.roll.clone();
                    x.peak.ts = ts;
                }
            }
        }
    }

    getStats(extra) {
        const peaks = {};
        const smooth = {};
        for (const [p, {roll, peak}] of this.periodized.entries()) {
            peaks[p] = {avg: peak ? peak.avg() : null, ts: peak ? peak.ts: null};
            smooth[p] = roll.avg();
        }
        return {
            avg: this.roll.avg(),
            max: this.max,
            peaks,
            smooth,
            ...extra,
        };
    }
}


async function getLocalRoutedIP() {
    const sock = net.createConnection(80, 'www.zwift.com');
    return await new Promise((resolve, reject) => {
        sock.on('connect', () => {
            try {
                resolve(sock.address().address);
            } finally {
                sock.end();
            }
        });
        sock.on('error', reject);
    });
}


function getLocalRoutedIface(ip) {
    for (const xDevice of cap.Cap.deviceList()) {
        for (const xAddr of xDevice.addresses) {
            if (xAddr.addr === ip) {
                return xDevice.name;
            }
        }
    }
}


class Sauce4ZwiftMonitor extends ZwiftPacketMonitor {

    static async factory() {
        const ip = await getLocalRoutedIP();
        const iface = getLocalRoutedIface(ip);
        return new this(iface, ip);
    }

    constructor(iface, ip) {
        super(iface);
        this.ip = ip;
        this.setMaxListeners(50);
        this._rolls = new Map();
        this._roadHistory = new Map();
        this._roadId;
        this._chatDeDup = [];
        this.athleteId = null;
        this.watching = null;
        this.profileFetchIds = new Set();
        this._pendingProfileFetches = [];
        this.on('incoming', this.onIncoming);
        this.on('outgoing', this.onOutgoing);
        rpc.register('updateAthlete', this.updateAthlete.bind(this));
        rpc.register('startLap', this.startLap.bind(this));
        rpc.register('getLaps', this.getLaps.bind(this));
        rpc.register('resetStats', this.resetStats.bind(this));
    }

    maybeLearnAthleteId(packet) {
        if (this.athleteId === null && packet.athleteId != null) {
            this.athleteId = packet.athleteId;
            if (this.watching == null) {
                this.watching = this.athleteId;
            }
        }
    }

    startLap() {
        console.debug("User requested lap start");
        const now = Date.now();
        for (const roll of this._rolls.values()) {
            roll.laps.at(-1).end = now;
            roll.laps.push({
                start: now,
                ...this.makeRollingPeaks()
            });
        }
    }

    getLaps(athleteId) {
        throw new Error("RETHINK XXX");
    }

    resetStats() {
        console.debug("User requested stats reset");
        this._rolls.clear();
    }

    updateAthlete(id, fName, lName, extra={}) {
        const d = this.athletes.get(id) || {};
        if (!d.ts) {
            d.ts = Date.now();
        }
        if (fName && fName.length === 1 && d.name && d.name[0] && d.name[0].length > 1 && d.name[0][0] === fName) {
            fName = d.name[0];  // Update is just the first initial but we know the full name already.
        }
        d.name = (fName || lName) ? [fName, lName].filter(x => x) : d.name;
        d.fullname = d.name && d.name.join(' ');
        Object.assign(d, extra);
        this.athletes.set(id, d);
        queueSaveAthleteCache(this.athletes);
        return d;
    }

    onIncoming(...args) {
        try {
            this._onIncoming(...args);
        } catch(e) {
            console.error("Incoming packet error:", e);
            throw e;
        }
    }

    _onIncoming(packet, from) {
        this.maybeLearnAthleteId(packet);
        for (const x of packet.playerUpdates) {
            if (x.payload && x.payload.$type) {
                const ts = highPrecTimeConv(x.ts);
                const p = x.payload;
                if (p.$type.name === 'PlayerEnteredWorld') {
                    const extra = p.weight ? {weight: p.weight / 1000} : undefined;
                    this.updateAthlete(p.athleteId, p.firstName, p.lastName, extra);
                } else if (p.$type.name === 'EventJoin') {
                    console.debug("Event Join:", p);
                } else if (p.$type.name === 'EventLeave') {
                    console.debug("Event Leave:", p);
                } else if (p.$type.name === 'ChatMessage') {
                    let dedup;
                    for (const [t, from] of this._chatDeDup) {
                        if (t === ts && from === p.from) {
                            dedup = true;
                            break;
                        }
                    }
                    if (dedup) {
                        console.warn("Deduping chat message:", ts, p.from);
                        continue;
                    }
                    this._chatDeDup.unshift([ts, p.from]);
                    this._chatDeDup.length = Math.min(10, this._chatDeDup.length);
                    this.emit('chat', {...p, ts});
                    this.updateAthlete(p.from, p.firstName, p.lastName, {avatar: p.avatar});
                } else if (x.payload.$type.name === 'RideOn') {
                    this.emit('rideon', {...p, ts});
                    this.updateAthlete(p.from, p.firstName, p.lastName);
                    console.debug("RideOn:", p);
                }
            }
        }
        for (const x of packet.playerStates) {
            if (this.processState(x, from) === false) {
                continue;
            }
            if (x.athleteId === this.watching) {
                this._watchingRoadSig = this._roadSig(x);
            }
        }
    }

    onOutgoing(...args) {
        try {
            this._onOutgoing(...args);
        } catch(e) {
            console.error("Outgoing packet error:", e);
            throw e;
        }
    }

    _onOutgoing(packet, from) {
        this.maybeLearnAthleteId(packet);
        const state = packet.state;
        if (!state) {
            return;
        }
        if (this.processState(state, from) === false) {
            return;
        }
        const watching = state.watchingAthleteId;
        if (watching != null && this.watching !== watching) {
            this.watching = watching;
            console.debug("Now watching:", watching);
        }
        if (state.athleteId === this.watching) {
            this._watchingRoadSig = this._roadSig(state);
        }
    }

    processFlags1(bits) {
        const _b0_1 = bits & 0x3; // XXX possibly bit 1 = bot and bit 0 = no power-meter/run?
        bits >>>= 2;
        const reverse = !!(bits & 0x1);
        bits >>>= 1;
        const reversing = !!(bits & 0x1);
        bits >>>= 1;
        const _b4_23 = bits & (1 << 20) - 1; // XXX no idea
        bits >>>= 20;
        const rideons = bits;
        return {
            _b0_1,
            reversing,
            reverse,
            _b4_23,
            rideons,
        };
    }

    processFlags2(bits) {
        const _b0_3 = bits & 0xF;  // Some of these represent using a powerup.
        // b0_3: 15 = has powerup? 0b1111 0 = using/used powerup
        bits >>>= 4;
        const turning = {
            0: null,
            1: 'RIGHT',
            2: 'LEFT',
        }[bits & 0x3];
        bits >>>= 2;
        const overlapping = bits & 0x1;  // or near junction or recently on junction.  It's unclear.
        bits >>>= 1;
        const roadId = bits & 0xFFFF;
        bits >>>= 16;
        const _rem2 = bits; // XXX no idea
        return {
            _b0_3,
            turning,
            roadId,
            overlapping,
            _rem2,
        };
    }

    _roadSig(state) {
        return [state.roadId, state.reverse].join();
    }

    getStats(rolls) {
        const end = rolls.end || Date.now();
        return {
            elapsed: (end - rolls.start) / 1000,
            power: rolls.power.getStats({np: rolls.power.roll.np({force: true})}),
            speed: rolls.speed.getStats(),
            hr: rolls.hr.getStats(),
            draft: rolls.draft.getStats(),
            cadence: rolls.cadence.getStats(),
        };
    }

    makeRollingPeaks() {
        const periods = [5, 30, 60, 300, 1200];
        return {
            power: new RollingPeaks(sauce.power.RollingPower, periods),
            speed: new RollingPeaks(sauce.data.RollingAverage, periods, {ignoreZeros: true}),
            hr: new RollingPeaks(sauce.data.RollingAverage, periods, {ignoreZeros: true}),
            cadence: new RollingPeaks(sauce.data.RollingAverage, [], {ignoreZeros: true}),
            draft: new RollingPeaks(sauce.data.RollingAverage, []),
        };
    }

    maybeUpdateAthleteFromProfile(gap, id) {
        if (this.profileFetchIds.has(id)) {
            return;
        }
        this.profileFetchIds.add(id);
        this._pendingProfileFetches.push([gap, id]);
        this._pendingProfileFetches.sort((a, b) => a[0] - b[0]);
        if (!this._athleteProfileUpdater) {
            this._athleteProfileUpdater = this.runAthleteProfileUpdater().finally(() =>
                this._athleteProfileUpdater = null);
        }
    }

    async runAthleteProfileUpdater() {
        if (this.zwiftTokens === undefined) {
            const zwiftLogin = await getAppSetting('zwiftLogin');
            this.zwiftTokens = zwiftLogin && await storage.load('zwift-tokens');
        }
        if (!this.zwiftTokens) {
            this._pendingProfileFetches.length = 0;
            return;
        }
        while (this._pendingProfileFetches.length) {
            const [, id] = this._pendingProfileFetches.shift();
            const data = this.athletes.get(id);
            if (data && data.ts && (Date.now() - data.ts) < (86400 * 1000)) {
                continue;
            }
            try {
                const p = await this._fetchProfile(id, this.zwiftTokens.accessToken);
                const info = this.updateAthlete(id, p.firstName, p.lastName, {
                    ftp: p.ftp,
                    avatar: p.imageSrcLarge || p.imageSrc,
                    weight: p.weight / 1000,
                    height: p.height / 10,
                    age: p.age,
                    level: Math.floor(p.achievementLevel / 100),
                    createdOn: p.createdOn ? +(new Date(p.createdOn)) : undefined,
                });
                console.debug("Athlete Info:", info);
                setTimeout(() => this.profileFetchIds.delete(id), 3600 * 1000);
            } catch(e) {
                console.error("Zwift API error:", e);
                this.updateAthlete(id);  // Update TS
            }
            await sauce.sleep(1000 + 1000 * Math.random());  // Slow it down while we don't know how robust it is, look for bulk EP.
        }
    }

    async _fetchProfile(id, token) {
        const r = await fetch(`https://us-or-rly101.zwift.com/api/profiles/${id}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Zwift-Api-Version': '2.5',
                'Authority': 'us-or-rly101.zwift.com',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9,und;q=0.8',
                'User-Agent': 'CNL/3.18.0 (Windows 10; Windows 10.0.19044) zwift/1.0.100641 curl/7.78.0-DEV',
            }
        });
        if (!r.ok) {
            await storage.delete('zwift-tokens');
            throw new Error(`[${r.status}]: ${await r.text()}`);
        }
        return await r.json();
    }

    processState(state, from) {
        state.ts = +worldTimeConv(state._worldTime);
        state.joinTime = +worldTimeConv(state._joinTime);
        const prevState = this.states.get(state.athleteId);
        if (prevState && prevState.ts > state.ts) {
            console.warn("Dropping stale packet", state.ts - prevState.ts);
            return false;
        }
        // Move this to zwift-packet thing..
        Object.assign(state, this.processFlags1(state._flags1));
        Object.assign(state, this.processFlags2(state._flags2));
        state.kj = state._mwHours / 1000 / (1000 / 3600);
        state.heading = headingConv(state._heading);  // degrees
        state.speed = state._speed / 1000000;  // km/h
        state.cadence = state._cadenceUHz ? state._cadenceUHz / 1000000 * 60 : null;  // rpm
        state.distance = state._distance / 100;  // cm -> meters
        const roadCompletion = state.roadLocation;
        state.roadCompletion = !state.reverse ? 1000000 - roadCompletion : roadCompletion;
        this.states.set(state.athleteId, state);
        if (!this._rolls.has(state.athleteId)) {
            const rollingPeaks = this.makeRollingPeaks();
            const start = Date.now();
            this._rolls.set(state.athleteId, {
                start,
                athleteId: state.athleteId,
                laps: [{start, ...rollingPeaks}],
                ...rollingPeaks,
            });
        }
        if (!this._roadHistory.has(state.athleteId)) {
            this._roadHistory.set(state.athleteId, {
                sig: this._roadSig(state),
                timeline: [],
                prevSig: null,
                prevTimeline: null,
            });
        }
        const roadLoc = this._roadHistory.get(state.athleteId);
        const curRoadSig = this._roadSig(state);
        if (curRoadSig !== roadLoc.sig) {
            roadLoc.prevSig = roadLoc.sig;
            roadLoc.prevTimeline = roadLoc.timeline;
            roadLoc.sig = curRoadSig;
            roadLoc.timeline = [];
        }
        const last = roadLoc.timeline.at(-1);
        if (last && state.roadCompletion < last.roadCompletion) {
            // This can happen when lapping a single road segment or if your avatar
            // Is stopped and sort of wiggling backwards. For safety we just nuke hist.
            roadLoc.timeline.length = 0;
        }
        roadLoc.timeline.push({ts: state.ts, roadCompletion: state.roadCompletion});
        const rolls = this._rolls.get(state.athleteId);
        const curLap = rolls.laps.at(-1);
        if (state.power != null) {
            rolls.power.add(state.ts, state.power);
            curLap.power.add(state.ts, state.power);
        }
        if (state.speed != null) {
            rolls.speed.add(state.ts, state.speed);
            curLap.speed.add(state.ts, state.speed);
        }
        if (state.heartrate != null) {
            rolls.hr.add(state.ts, state.heartrate);
            curLap.hr.add(state.ts, state.heartrate);
        }
        if (state.draft != null) {
            rolls.draft.add(state.ts, state.draft);
            curLap.draft.add(state.ts, state.draft);
        }
        if (state.cadence != null) {
            rolls.cadence.add(state.ts, state.cadence);
            curLap.cadence.add(state.ts, state.cadence);
        }
        state.stats = this.getStats(rolls);
        state.laps = rolls.laps.map(x => this.getStats(x));
        if (this.watching === state.athleteId) {
            this.emit('watching', this.cleanState(state));
        }
    }

    async start() {
        this._active = true;
        this.athletes = await getAthleteCache();
        this.states = new Map();
        super.start();
        this._nearbyJob = this.nearbyProcessor();
    }

    async stop() {
        this._active = false;
        super.stop();
        try {
            await this._nearbyJob;
        } finally {
            this._nearybyJob = null;
        }
    }

    realGap(a, b) {
        const aSig = this._roadSig(a);
        const bSig = this._roadSig(b);
        let leaderTimeline;
        let trailing;
        if (aSig === bSig) {
            if (a.roadCompletion > b.roadCompletion) {
                leaderTimeline = this._roadHistory.get(a.athleteId).timeline;
                trailing = b;
            } else if (a.roadCompletion < b.roadCompletion) {
                leaderTimeline = this._roadHistory.get(b.athleteId).timeline;
                trailing = a;
            }
        } else {
            const aHist = this._roadHistory.get(a.athleteId);
            if (aHist.prevSig === bSig) {
                leaderTimeline = aHist.prevTimeline;
                trailing = b;
            } else {
                const bHist = this._roadHistory.get(a.athleteId);
                if (bHist.prevSig === aSig) {
                    leaderTimeline = bHist.prevTimeline;
                    trailing = a;
                }
            }
        }
        if (!trailing == null || !leaderTimeline) {
            return null;
        }
        let prev;
        // TODO: Use binary search.
        for (const x of Array.from(leaderTimeline).reverse()) {  // newest to oldest...
            if (x.roadCompletion <= trailing.roadCompletion) {
                let offt = 0;
                if (prev) {
                    const dist = prev.roadCompletion - x.roadCompletion;
                    const time = prev.ts - x.ts;
                    offt = (trailing.roadCompletion - x.roadCompletion) / dist * time;
                }
                return Math.abs((trailing.ts - x.ts - offt) / 1000);
            }
            prev = x;
        }
        return null;
    }

    isFirstLeadingSecond(a, b) {
        const aSig = this._roadSig(a);
        const bSig = this._roadSig(b);
        if (aSig === bSig) {
            return a.roadCompletion > b.roadCompletion;
        } else {
            const aHist = this._roadHistory.get(a.athleteId);
            if (aHist.prevSig === bSig) {
                return true;
            } else {
                const bHist = this._roadHistory.get(a.athleteId);
                if (bHist.prevSig === aSig) {
                    return false;
                }
            }
        }
    }

    gcStates() {
        const now = Date.now();
        for (const [k, x] of this.states.entries()) {
            const age = now - x.ts;
            if (age > 30 * 1000) {
                this.states.delete(k);
            }
        }
    }

    async nearbyProcessor() {
        let errBackoff = 1000;
        const target = Date.now() % 1000;
        while (this._active) {
            if (this.watching == null) {
                await sleep(100);
                continue;
            }
            try {
                await this._nearbyProcessor();
                const offt = Date.now() % 1000;
                const schedSleep = 1000 - (offt - target);
                await sleep(schedSleep);
            } catch(e) {
                console.error("Unexpected processor error:", e);
                await sleep(errBackoff *= 2);
            }
        }
    }

    cleanState(raw) {
        return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
    }

    async _nearbyProcessor() {
        this.gcStates();
        const cleanState = this.cleanState.bind(this);
        const watching = this.states.get(this.watching);
        if (!watching) {
            return;
        }
        const nearby = [];
        for (const [k, x] of this.states.entries()) {
            if (!x.speed && k !== this.watching) {
                continue;
            }
            const leading = this.isFirstLeadingSecond(watching, x);
            if (leading == null) {
                if (k === this.watching) {
                    debugger;
                } else {
                    continue;
                }
            }
            const sign = leading ? 1 : -1;
            let gap = this.realGap(watching, x);
            let isGapEst = gap == null;
            const gapDistance = crowDistance(watching, x);
            if (isGapEst) {
                gap = estGap(watching, x, gapDistance);
            }
            nearby.push({
                gapDistance,
                gap: gap * sign,
                isGapEst,
                athlete: this.athletes.get(k),
                watching: this.watching === k,
                ...x
            });
        }
        nearby.sort((a, b) => a.gap - b.gap);
        this.emit('nearby', nearby.map(cleanState));

        const centerIdx = nearby.findIndex(x => x.watching);
        const veryNear = nearby.slice(Math.max(0, centerIdx - 20), centerIdx + 20);
        veryNear.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
        for (const x of veryNear) {
            this.maybeUpdateAthleteFromProfile(Math.abs(x.gap), x.athleteId);
        }
        const groups = [];
        let curGroup;
        for (const x of nearby) {
            if (!curGroup) {
                curGroup = {athletes: [x]};
            } else {
                const last = curGroup.athletes.at(-1);
                const gap = x.gap - last.gap;
                if (gap > 2) {
                    curGroup.innerGap = gap;
                    groups.push(curGroup);
                    curGroup = {athletes: []};
                }
                curGroup.athletes.push(x);
            }
            curGroup.watching = curGroup.watching || x.athleteId === this.watching;
        }
        if (curGroup && curGroup.athletes.length) {
            groups.push(curGroup);
        }
        const watchingIdx = groups.findIndex(x => x.watching);
        if (watchingIdx === -1) {
            debugger; // Bug
        }
        for (let i = 0; i < groups.length; i++) {
            const x = groups[i];
            x.power = sauce.data.avg(x.athletes.map(x => x.power));
            x.draft = sauce.data.avg(x.athletes.map(x => x.draft));
            x.speed = sauce.data.median(x.athletes.map(x => x.speed));
            x.heartrate = sauce.data.avg(x.athletes.map(x => x.heartrate).filter(x => x));
            if (watchingIdx !== i) {
                const edge = watchingIdx < i ? x.athletes[0] : x.athletes.at(-1);
                x.isGapEst = edge.isGapEst;
                x.gap = edge.gap;
                if (i < groups.length - 1 && x.gap - groups[i + 1] < 2) {
                    debugger;
                }
            } else {
                x.gap = 0;
                x.isGapEst = false;
            }
        }
        this.emit('groups', groups.map(g =>
            (g.athletes = g.athletes.map(cleanState), g)));
    }
}


async function getCapturePermission() {
    if (os.platform() === 'darwin') {
        await new Promise((resolve, reject) => {
            sudo.exec(`chown ${os.userInfo().uid} /dev/bpf*`, {name: 'Sauce for Zwift'},
                (e, stdout, stderr) => {
                    if (stderr) {
                        console.warn(stderr);
                    }
                    if (e) {
                        reject(e);
                    } else {
                        resolve(stdout);
                    }
                });
        });
    } else {
        await electron.dialog.showErrorBox(
            'Network capture permission required to continue',
            'Sauce extends Zwift by capturing the game data sent over the network ' +
            'For MacOS this requires read permission on the "/dev/bpf0" file.'
        );
        throw new Error("libpcap permission required");
    }
}


export default {
    Sauce4ZwiftMonitor,
    getCapturePermission,
};
