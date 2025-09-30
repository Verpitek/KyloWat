# KyloWat
An Energy API for Minecraft Bedrock Edition

## How To Use
First, you must decide how you want machines to be created in the first place. You have two options:

1. You define it yourself using the Machine class to create a new machine object
2. You use the MachineRegistry class to register an ID, which both entities and blocks will be tracked automatically

Afterwards, to enable automatic energy transferring logic, you will use the EnergySystem class. Essentially, this will transfer energy between linked machines. 

EXAMPLE:
```
import { world, system } from "@minecraft/server"
import * as kylowat from "./kylowatAPI";
world.afterEvents.worldLoad.subscribe(ev => {
    kylowat.MachineRegistry.register("minecraft:dirt", 0, 30, 0, 1)
    kylowat.MachineRegistry.register("minecraft:creeper", 0, 30, 0, 1)
    kylowat.EnergySystem.start(10)
})
```

Logic is determined by how the machine is registered and the "Energy System" only handles the logic of transferring energy between linked machines. Machines do not need to be linked two-way. To give a machine logic, use the "run()" function. This will return true/false and check energy reserves compared to cost. Effectively, allowing you to determine functionality. 

EXAMPLE
```
import { world, system } from "@minecraft/server"
import * as kylowat from "./kylowatAPI";
world.beforeEvents.playerInteractWithBlock.subscribe(ev => {
    if (ev.isFirstEvent){
        system.run(() => {
            if (kylowat.MachineRegistry.has(ev.block.typeId)){
                // let machine = new kylowat.Machine(ev.block.typeId, ev.block.location) will 
                // instead grab an existing machine if one exists at this location
                let id = kylowat.Machine.findIdByLocation(ev.block.location)
                let machine = kylowat.Machine.reconstructFromId(id)
                if (machine.run()){
                    ev.player.addEffect("resistance", 60)
                }

                world.sendMessage("§bID: §c" + machine.id)
                world.sendMessage("§bEnergy: §c" + machine.currentEnergy)
                world.sendMessage(
                    "§bConnected Machines: §c" +
                    machine.getLinkedMachines().map(m => m.id).join(", ")
                ); 
            }
        })
    }
})
```
