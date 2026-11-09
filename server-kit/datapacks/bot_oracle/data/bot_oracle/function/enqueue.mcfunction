# Called as the player the event is about. Usage: function bot_oracle:enqueue {ev:"name"}
$data modify storage bot_oracle:tmp e set value {ev:"$(ev)"}
data modify storage bot_oracle:tmp e.uuid set from entity @s UUID
data modify storage bot_oracle:tmp e.dim set from entity @s Dimension
execute store result storage bot_oracle:tmp e.x int 1 run data get entity @s Pos[0]
execute store result storage bot_oracle:tmp e.y int 1 run data get entity @s Pos[1]
execute store result storage bot_oracle:tmp e.z int 1 run data get entity @s Pos[2]
execute store result storage bot_oracle:tmp e.t int 1 run time query gametime
data modify storage bot_oracle:q events append from storage bot_oracle:tmp e
