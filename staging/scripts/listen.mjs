// Keep the running local staging (and its connector sessions) when started twice.
export async function listenLocalStaging(server, port = 4173) {
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { server.off('error', failed); server.off('listening', ready); };
      const failed = error => { cleanup(); reject(error); };
      const ready = () => { cleanup(); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(port, '127.0.0.1');
    });
    return 'started';
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    let health;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        redirect: 'error', signal: AbortSignal.timeout(2000)
      });
      if (response.ok) health = await response.json();
    } catch { /* Another service, or a listener that is not responding. */ }
    if (health?.environment === 'staging' && health?.project === 'ludy-staging') return 'existing';
    throw new Error(`Le port 127.0.0.1:${port} est occupe par un service qui ne repond pas comme Ludy staging. Aucun processus n'a ete arrete. Verifiez ce service avant de relancer.`);
  }
}
