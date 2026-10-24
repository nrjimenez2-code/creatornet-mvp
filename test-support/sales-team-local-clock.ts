import type {PGlite} from "@electric-sql/pglite";

/** Only for a fresh, disposable in-memory database, before installing sources.
 * Keeps real migration bytes, defaults, immutable history and validators intact.
 * Advances a synthetic database clock; never changes the host or provider time. */
export async function installTeamLocalClock(db:PGlite){
 await db.exec(`
  alter function pg_catalog.clock_timestamp() rename to team_fixture_real_clock;
  create function pg_catalog.clock_timestamp() returns timestamptz language sql volatile
   as $$select pg_catalog.team_fixture_real_clock()+coalesce(nullif(current_setting('creatornet.fixture_offset_ms',true),''),'0')::double precision*interval '1 millisecond'$$;
  alter function pg_catalog.now() rename to team_fixture_real_now;
  create function pg_catalog.now() returns timestamptz language sql stable as $$select pg_catalog.clock_timestamp()$$;
 `);
 return async(milliseconds:number)=>{
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0)throw Error("A nonnegative synthetic clock offset is required");
  await db.query("select set_config('creatornet.fixture_offset_ms',$1,false)",[String(milliseconds)]);
 };
}
