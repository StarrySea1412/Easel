import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { layoutOfficeLabels } = await loadTsModule('../labelLayout.ts', import.meta.url);

function assertReadable(items, width, height) {
  for (const item of items) {
    assert.ok(item.left >= 0 && item.top >= 0 && item.left + item.width <= width && item.top + item.height <= height);
    for (const other of items) if (item.id !== other.id) {
      assert.ok(item.left + item.width <= other.left || other.left + other.width <= item.left
        || item.top + item.height <= other.top || other.top + other.height <= item.top, `${item.id} overlaps ${other.id}`);
    }
  }
}

test('six projected agents stay readable in the actual narrow desktop scene', () => {
  const anchors = Array.from({ length: 6 }, (_, index) => ({ id: String(index), x: 190 + index % 3 * 36,
    y: 180 + Math.floor(index / 3) * 24, width: index === 0 ? 166 : 126, height: index === 0 ? 56 : 34, selected: index === 0 }));
  const before = structuredClone(anchors);
  const result = layoutOfficeLabels(anchors, 480, 420);
  assert.equal(result.length, 6);
  assertReadable(result, 480, 420);
  assert.equal(result[0].id, '0');
  assert.equal(result[0].left, 190 - 83);
  assert.deepEqual(anchors, before);
  assert.deepEqual(layoutOfficeLabels(anchors, 480, 420), result);
});

test('edge anchors remain within a mobile scene, preserving selected member priority', () => {
  const result = layoutOfficeLabels([
    { id:'left', x:1, y:1, width:122, height:34, selected:false },
    { id:'selected', x:298, y:348, width:166, height:56, selected:true },
    { id:'right', x:298, y:348, width:122, height:34, selected:false },
  ], 300, 350);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'selected');
  assertReadable(result, 300, 350);
});

test('overcrowded view hides excess labels instead of stacking unreadable names', () => {
  const anchors = Array.from({length:32}, (_, index) => ({id:String(index), x:120, y:120, width:126, height:34, selected:index===31}));
  const result = layoutOfficeLabels(anchors, 260, 220);
  assert.ok(result.length < 32 && result.length > 0);
  assert.equal(result[0].id,'31');
  assertReadable(result,260,220);
  assert.deepEqual(layoutOfficeLabels(anchors,80,80),[]);
});

test('labels avoid projected people, hands and monitors rather than obscuring their work', () => {
  const areas = [{left:150,top:125,width:200,height:170}, {left:380,top:170,width:85,height:100}];
  const anchors = Array.from({length:6},(_,i)=>({id:String(i),x:180+i*30,y:170+i*10,width:126,height:48,selected:i===0}));
  const result = layoutOfficeLabels(anchors,640,450,areas);
  assert.ok(result.some(label=>label.id==='0'));
  assertReadable(result,640,450);
  for (const label of result) for (const area of areas) assert.ok(label.left+label.width<=area.left || label.left>=area.left+area.width || label.top+label.height<=area.top || label.top>=area.top+area.height);
  assert.equal(layoutOfficeLabels(anchors,640,450,[{left:0,top:0,width:640,height:450}]).length,0);
});

test('selected close-up label can move to a distant clear edge without covering the desk', () => {
  const anchor = {id:'selected',x:720,y:160,width:166,height:56,selected:true};
  const area = {left:225,top:0,width:775,height:500};
  const result = layoutOfficeLabels([anchor],1000,500,[area]);
  assert.equal(result.length,1);
  assert.ok(result[0].left+result[0].width<area.left);
  assertReadable(result,1000,500);
});
