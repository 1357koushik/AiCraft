function bot_oracle:emit with storage bot_oracle:q events[0]
data remove storage bot_oracle:q events[0]
execute if data storage bot_oracle:q events[0] run function bot_oracle:drain
