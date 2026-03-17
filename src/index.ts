import {
    matchInit,
    matchJoinAttempt,
    matchJoin,
    matchLeave,
    matchLoop,
    matchTerminate,
    matchSignal,
} from "./match_handler";
import {
    rpcGetPlayerRank,
    rpcGetLeaderboard,
    initLeaderboard,
} from "./rank_handler";
import {
    rpcCreateCustomRoom,
    rpcJoinCustomRoom,
    rpcFindOrCreateRankedMatch,
} from "./room_handler";

function InitModule(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer
) {
    logger.info("MEANFALL module initializing...");

    initLeaderboard(nk, logger);

    initializer.registerMatch("meanfall_match", {
        matchInit: matchInit,
        matchJoinAttempt: matchJoinAttempt,
        matchJoin: matchJoin,
        matchLeave: matchLeave,
        matchLoop: matchLoop,
        matchTerminate: matchTerminate,
        matchSignal: matchSignal,
    });

    initializer.registerRpc("get_player_rank", rpcGetPlayerRank);
    initializer.registerRpc("get_leaderboard", rpcGetLeaderboard);
    initializer.registerRpc("create_custom_room", rpcCreateCustomRoom);
    initializer.registerRpc("join_custom_room", rpcJoinCustomRoom);
    initializer.registerRpc("find_or_create_ranked_match", rpcFindOrCreateRankedMatch);
};
