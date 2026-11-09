# Runs on every server start and /reload (server context).
scoreboard objectives add bo_deaths deathCount
execute unless data storage bot_oracle:q events run data modify storage bot_oracle:q events set value []
say [oracle] {"ev":"load","pack":1}
