from pathlib import Path
import pytest
from PIL import Image
from easel.attachment_media import stage_image


def test_stage_preserves_original_and_uses_allowed_media_root(tmp_path):
    source=tmp_path/'inbox.png'; Image.new('RGB',(2,2),'red').save(source)
    before=source.read_bytes();state=tmp_path/'state'
    staged=stage_image(source,state,'own')
    assert staged.is_relative_to(state/'media/easel-attachments/own')
    assert staged.read_bytes()==before==source.read_bytes()
    assert stage_image(source,state,'own')==staged
    assert stage_image(source,state,'other')!=staged


def test_invalid_image_and_symlink_are_rejected(tmp_path):
    source=tmp_path/'invalid.png';source.write_bytes(b'not an image')
    with pytest.raises((ValueError,OSError)): stage_image(source,tmp_path/'state','own')
    state=tmp_path/'state';state.mkdir()
    try:
        (state/'media').symlink_to(tmp_path,target_is_directory=True)
    except OSError:
        pytest.skip('Symlink privilege unavailable; exercised in Linux acceptance')
    Image.new('RGB',(1,1)).save(source)
    with pytest.raises(ValueError): stage_image(source,state,'own')
