import { world, system } from "@minecraft/server"

world.afterEvents.playerPlaceBlock.subscribe(ev => {
    if (!MachineRegistry.has(ev.block.typeId)) return;
    const machine = new Machine(ev.block.typeId, ev.block.location)
});

world.afterEvents.playerBreakBlock.subscribe(ev => {
    if (!MachineRegistry.has(ev.brokenBlockPermutation.type.id)) return;
    let id = Machine.findIdByLocation(ev.block.location);
    Machine.deleteId(id)
});

/**
 * Represents a registered block ID
 * that has default Machine components
 */
export class MachineRegistry {
    static objectiveId = "machine_registry";
    static cache = new Map();

    static ensureObjective() {
        try {
            world.scoreboard.addObjective(this.objectiveId, "Machine Registry");
        } catch {}
    }

    static register(blockId, energyCost = 0, maxEnergy = 0, startEnergy = 0, transferRate = 50) {
        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        obj.setScore(`${blockId}:energyCost`, energyCost);
        obj.setScore(`${blockId}:maxEnergy`, maxEnergy);
        obj.setScore(`${blockId}:startEnergy`, startEnergy);
        obj.setScore(`${blockId}:transferRate`, transferRate);

        this.cache.set(blockId, { energyCost, maxEnergy, startEnergy, transferRate });
    }

    static get(blockId) {
        if (this.cache.has(blockId)) {
            const cached = this.cache.get(blockId);
            return [cached.energyCost, cached.maxEnergy, cached.startEnergy, cached.transferRate];
        }

        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        const energyCost = obj.getScore(`${blockId}:energyCost`) ?? 0;
        const maxEnergy = obj.getScore(`${blockId}:maxEnergy`) ?? 0;
        const startEnergy = obj.getScore(`${blockId}:startEnergy`) ?? 0;
        const transferRate = obj.getScore(`${blockId}:transferRate`) ?? 50;

        if (!this.has(blockId)) this.register(blockId, energyCost, maxEnergy, startEnergy, transferRate);

        this.cache.set(blockId, { energyCost, maxEnergy, startEnergy, transferRate });

        return [energyCost, maxEnergy, startEnergy, transferRate];
    }

    static has(blockId) {
        if (this.cache.has(blockId)) return true;

        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        try {
            return obj.getScore(`${blockId}:energyCost`) != null;
        } catch {
            return false;
        }
    }
}

/**
 * Represents a single machine tied to a block.
 * A machine has energy, energyCost, and maxEnergy values
 * which are persisted using the scoreboard.
 */
export class Machine {
    static cache = new Map();

    constructor(typeId, location, energyCost = 0, maxEnergy = 0, currentEnergy = 0, transferRate = 50) {
        if (!typeId || !location) throw new Error("Machine requires typeId and location");

        const key = `${location.x}:${location.y}:${location.z}`;

        if (Machine.cache.has(key)) {
            return Machine.cache.get(key);
        }

        let existingId = Machine.findIdByLocation(location);
        let id = existingId;

        if (id == null) {
            this.id = makeUUID();

            const registryDefaults = MachineRegistry.has(typeId) ? MachineRegistry.get(typeId) : [];
            const [regEnergyCost, regMaxEnergy, regStartEnergy, regTransferRate] = registryDefaults;
            this.energyCost = regEnergyCost !== undefined ? regEnergyCost : energyCost;
            this.maxEnergy = regMaxEnergy !== undefined ? regMaxEnergy : maxEnergy;
            this.currentEnergy = regStartEnergy !== undefined ? regStartEnergy : currentEnergy;
            this.transferRate = regTransferRate !== undefined ? regTransferRate : transferRate;

            const obj = world.scoreboard.addObjective(this.id, this.id);
            obj.setScore("x", location.x);
            obj.setScore("y", location.y);
            obj.setScore("z", location.z);
            obj.setScore("energyCost", this.energyCost);
            obj.setScore("maxEnergy", this.maxEnergy);
            obj.setScore("energy", this.currentEnergy);
            obj.setScore("transferRate", this.transferRate);

        } else {
            const machine = Machine.reconstructFromId(id);
            this.id = machine.id;
            this.energyCost = machine.energyCost;
            this.maxEnergy = machine.maxEnergy;
            this.currentEnergy = machine.currentEnergy;
            this.transferRate = machine.transferRate;
        }

        Machine.cache.set(key, this);
    }

    static findIdByLocation(loc) {
        try {
            for (const obj of world.scoreboard.getObjectives()) {
                const sx = obj.getScore("x");
                const sy = obj.getScore("y");
                const sz = obj.getScore("z");
                if (sx === loc.x && sy === loc.y && sz === loc.z) {
                    return obj.displayName;
                }
            }
        } catch {}
        return null;
    }

    static reconstructFromId(id) {
        const obj = world.scoreboard.getObjective(id) || world.scoreboard.addObjective(id, id);
        if (!obj) return null;

        const x = obj.getScore("x");
        const y = obj.getScore("y");
        const z = obj.getScore("z");
        const key = `${x}:${y}:${z}`;

        const energyCost = obj.getScore("energyCost");
        const maxEnergy = obj.getScore("maxEnergy");
        const currentEnergy = obj.getScore("energy");
        const transferRate = obj.getScore("transferRate");

        const machine = Object.create(Machine.prototype);
        machine.id = id;
        machine.energyCost = energyCost;
        machine.maxEnergy = maxEnergy;
        machine.currentEnergy = currentEnergy;
        machine.transferRate = transferRate;

        Machine.cache.set(key, machine);
        return machine;
    }

    static deleteId(id) {
        const obj = world.scoreboard.getObjective(id) || world.scoreboard.addObjective(id, id);
        const key = `${obj.getScore("x")}:${obj.getScore("y")}:${obj.getScore("z")}`;
        Machine.cache.delete(key);
        world.scoreboard.removeObjective(obj)
    }

    linkMachine(otherMachine, priority = 1) {
        if (!otherMachine || otherMachine.id === this.id) return;
        const obj = world.scoreboard.getObjective(this.id);
        const linkKey = `link:${otherMachine.id}`;
        obj.setScore(linkKey, priority);
    }

    unlinkMachine(otherMachine) {
        if (!otherMachine || otherMachine.id === this.id) return;
        const obj = world.scoreboard.getObjective(this.id);
        const linkKey = `link:${otherMachine.id}`;
        obj.removeScore(linkKey);
    }

    getLinkedMachines() {
        const obj = world.scoreboard.getObjective(this.id);
        const linked = [];
        for (const scoreName of obj.getScoreNames()) {
            if (scoreName.startsWith("link:")) {
                const linkedId = scoreName.split(":")[1];
                const machine = Machine.reconstructFromId(linkedId);
                if (machine) linked.push(machine);
            }
        }
        return linked;
    }

    get location() {
        return {
            x: this.get("x"),
            y: this.get("y"),
            z: this.get("z")
        };
    }

    get(name) {
        const obj = world.scoreboard.getObjective(this.id) || world.scoreboard.addObjective(this.id, this.id);
        if (!obj) return null;
        try {
            return obj.getScore(name);
        } catch {
            return null;
        }
    }

    delete() {
        world.scoreboard.removeObjective(`${this.id}`);
        const key = `${this.location.x}:${this.location.y}:${this.location.z}`;
        Machine.cache.delete(key);
        freeUUID(this.id);
    }
}

const uuidObj = "MachineUUIDs"
function makeUUID() {
    let uuid;
    const obj = world.scoreboard.getObjective(uuidObj) ?? world.scoreboard.addObjective(uuidObj, uuidObj);

    do {
        uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    } while (obj.hasParticipant(uuid));

    obj.setScore(uuid, 1);

    return uuid;
}

function freeUUID(uuid) {
    const obj = world.scoreboard.getObjective(uuidObj) ?? world.scoreboard.addObjective(uuidObj, uuidObj);
    if (obj.hasParticipant(uuid)) {
        obj.removeParticipant(uuid);
    }
}
