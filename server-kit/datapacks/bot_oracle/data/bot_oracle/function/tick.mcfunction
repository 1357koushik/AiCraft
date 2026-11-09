# Runs every tick in server context, so every `say` below is attributed to [Server], never to a player.
execute as @a[scores={bo_deaths=1..}] at @s run function bot_oracle:ev/death
execute if data storage bot_oracle:q events[0] run function bot_oracle:drain
