# Commute × Rent — NYC

**Live: https://puterfaction.github.io/commute-map/**

Click anywhere to put your office there. The map redraws door-to-door commute
times (walk + subway, weekday schedule) from that point across the whole city,
and overlays real listing-level rents — 22,940 listings from StreetEasy and
Craigslist combined (duplicates merged), snapshot of late July 2026.

- Commute times: MTA subway GTFS → all-pairs station matrix (496×496),
  final walking legs computed in your browser, so moving the office is instant.
- **Value view** shows both at once: color is the commute band, brightness is
  how cheap the rent is *for that commute* — bright = best deal at that distance.
- Rents: neighborhood medians recompute live as you filter by bedrooms or
  in-unit washer/dryer. Switch to **rent** view for a choropleth, or open the
  **rent vs commute** panel for the Pareto frontier — the cheapest place to
  live at each commute length.
- Type a station name to jump the office there.
- Share a specific office with the URL hash: `#40.6906,-73.9827`.

Rent data is a point-in-time snapshot; listings have turned over since.
Built by [@puterfaction](https://x.com/puterfaction) with Claude.
