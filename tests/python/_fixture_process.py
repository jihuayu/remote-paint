"""Retire owned Node fixture processes even when setup or client cleanup fails."""
from __future__ import annotations
import asyncio

async def close_node_fixture(child, clients, *, graceful_timeout=3):
    first_error = None
    for client in clients:
        try:
            await client.aclose()
        except BaseException as error:
            if first_error is None:
                first_error = error

    async def finish():
        if child.stdin is not None and not child.stdin.is_closing():
            if child.returncode is None:
                child.stdin.write(b'close\n')
                try:
                    await child.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            child.stdin.close()
            try:
                await child.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass
        return await child.communicate()

    try:
        out, err = await asyncio.wait_for(finish(), graceful_timeout)
    except BaseException as error:
        # A deadline is still a failing observation. Reap the actual process
        # before propagating it; a timeout alone is not retirement evidence.
        if child.returncode is None:
            child.kill()
        await asyncio.wait_for(child.communicate(), 3)
        raise first_error if first_error is not None else error
    if first_error is not None:
        raise first_error
    if child.returncode != 0:
        raise AssertionError('Owned Node fixture exit '+str(child.returncode)+': '+err.decode(errors='replace')[-2000:])
    return out, err
