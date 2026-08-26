export function privateVenue() {
  return {
    name: String(process.env.NOCTURNE_VENUE_NAME || '').trim(),
    address: String(process.env.NOCTURNE_VENUE_ADDRESS || '').trim()
  };
}

export function privateVenueConfigured() {
  const venue = privateVenue();
  return Boolean(venue.name && venue.address);
}

export function privateVenueMapUrl() {
  const { address } = privateVenue();
  return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '';
}
