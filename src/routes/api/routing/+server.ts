import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Pool } from 'pg';

// データベース接続プールの作成
const pool = new Pool({
	host: 'localhost',
	port: 5432,
	database: 'shikoku_routing',
	user: 'user',
	password: 'password'
});

export const POST: RequestHandler = async ({ request, url }) => {
	const pathname = url.pathname;

	// ルート検索エンドポイント
	if (pathname.endsWith('/search')) {
		try {
			const { startLat, startLon, endLat, endLon } = await request.json();

			// 入力値の検証
			if (!startLat || !startLon || !endLat || !endLon) {
				return json({ error: '開始地点と終了地点の座標が必要です' }, { status: 400 });
			}

			// 最寄りのノードを検索
			const startNodeQuery = `
				SELECT id, ST_Distance(
					the_geom::geography,
					ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
				) as distance
				FROM ways_vertices_pgr
				ORDER BY the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
				LIMIT 1;
			`;

			const endNodeQuery = `
				SELECT id, ST_Distance(
					the_geom::geography,
					ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
				) as distance
				FROM ways_vertices_pgr
				ORDER BY the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
				LIMIT 1;
			`;

			// 最寄りノードの取得
			const startNodeResult = await pool.query(startNodeQuery, [startLon, startLat]);
			const endNodeResult = await pool.query(endNodeQuery, [endLon, endLat]);

			if (startNodeResult.rows.length === 0 || endNodeResult.rows.length === 0) {
				return json({ error: '指定された座標の近くにノードが見つかりません' }, { status: 404 });
			}

			const startNode = startNodeResult.rows[0].id;
			const endNode = endNodeResult.rows[0].id;

			// pgRoutingを使用した最短経路検索
			const routeQuery = `
				SELECT 
					seq,
					path_seq,
					node,
					edge,
					cost,
					agg_cost,
					ST_AsGeoJSON(w.the_geom) as geom,
					w.name,
					w.length_m
				FROM pgr_dijkstra(
					'SELECT gid as id, source, target, cost, reverse_cost FROM ways',
					$1::bigint,
					$2::bigint,
					directed := true
				) as r
				LEFT JOIN ways w ON r.edge = w.gid
				WHERE edge IS NOT NULL;
			`;

			const routeResult = await pool.query(routeQuery, [startNode, endNode]);

			if (routeResult.rows.length === 0) {
				return json({ error: 'ルートが見つかりません' }, { status: 404 });
			}

			// 結果の整形
			const route = {
				startNode,
				endNode,
				totalCost: routeResult.rows[routeResult.rows.length - 1].agg_cost,
				totalDistance: routeResult.rows.reduce((sum, row) => sum + (row.length_m || 0), 0),
				segments: routeResult.rows.map(row => ({
					sequence: row.seq,
					node: row.node,
					edge: row.edge,
					cost: row.cost,
					accumulatedCost: row.agg_cost,
					geometry: row.geom ? JSON.parse(row.geom) : null,
					name: row.name,
					length: row.length_m
				}))
			};

			return json(route);
		} catch (error) {
			console.error('Routing error:', error);
			return json({ error: 'ルート検索中にエラーが発生しました' }, { status: 500 });
		}
	}

	// 最寄りノード検索エンドポイント
	if (pathname.endsWith('/nearest-node')) {
		try {
			const { lat, lon } = await request.json();

			if (!lat || !lon) {
				return json({ error: '座標が必要です' }, { status: 400 });
			}

			const query = `
				SELECT 
					id,
					ST_X(the_geom) as lon,
					ST_Y(the_geom) as lat,
					ST_Distance(
						the_geom::geography,
						ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
					) as distance
				FROM ways_vertices_pgr
				ORDER BY the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
				LIMIT 5;
			`;

			const result = await pool.query(query, [lon, lat]);

			return json({
				nodes: result.rows
			});
		} catch (error) {
			console.error('Nearest node error:', error);
			return json({ error: '最寄りノード検索中にエラーが発生しました' }, { status: 500 });
		}
	}

	return json({ error: 'Not found' }, { status: 404 });
};

// ヘルスチェックエンドポイント
export const GET: RequestHandler = async () => {
	try {
		await pool.query('SELECT 1');
		return json({ status: 'ok', database: 'connected' });
	} catch (error) {
		console.error('Database connection error:', error);
		return json({ status: 'error', database: 'disconnected' }, { status: 500 });
	}
};