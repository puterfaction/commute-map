# Commute × Rent — NYC

**Live: https://puterfaction.github.io/commute-map/**

Click anywhere to put your office there. The map redraws door-to-door commute
times (walk + subway, weekday schedule) from that point across the whole city,
and overlays real listing-level rents — 18,109 StreetEasy listings, snapshot of
July 31, 2026.

- Commute times: MTA subway GTFS → all-pairs station matrix (496×496),
  final walking legs computed in your browser, so moving the office is instant.
- Rents: neighborhood medians recompute live as you filter by bedrooms or
  in-unit washer/dryer. Switch to **rent** view for a choropleth, or open the
  **rent vs commute** panel for the Pareto frontier — the cheapest place to
  live at each commute length.
- Share a specific office with the URL hash: `#40.6906,-73.9827`.

Rent data is a point-in-time snapshot; listings have turned over since.
Built by [@puterfaction](https://x.com/puterfaction) with Claude.
