import { world, system } from "@minecraft/server"
import * as kylowat from "./kylowatAPI";

world.beforeEvents.playerInteractWithBlock.subscribe(ev => {
    if (ev.isFirstEvent){
        system.run(() => {
            if (kylowat.MachineRegistry.has(ev.block.typeId)){
                // let machine = new kylowat.Machine(ev.block.typeId, ev.block.location) will instead grab an existing machine if one exists at this location
                let id = kylowat.Machine.findIdByLocation(ev.block.location, ev.block.dimension.id)
                if(id){
                    let machine = kylowat.Machine.reconstructFromId(id)
                    machine.run()
                    ev.player.addEffect("resistance", 60)
                    world.sendMessage("§bID: §c" + machine.id)
                    world.sendMessage("§bEnergy: §c" + machine.currentEnergy)
                    world.sendMessage("§bDim: §c" + machine.dim)
                    world.sendMessage(
                        "§bConnected Machines: §c" +
                        machine.getLinkedMachines().map(m => m.id).join(", ")
                    ); 
                }
            }
        })
    }
})

world.afterEvents.worldLoad.subscribe(ev => {
    kylowat.MachineRegistry.register("minecraft:dirt", 1, 30, 0, 1)
    kylowat.MachineRegistry.register("minecraft:creeper", 1, 30, 0, 1)
    kylowat.EnergySystem.start(10)
})